import * as path from 'path';
import * as fs from 'fs';
import * as envPaths from 'env-paths';
import { getStandalone, generateCACertificate } from 'mockttp';
import { MockttpStandalone } from 'mockttp/dist/standalone/mockttp-standalone';
import { Mutex } from 'async-mutex';

import updateCommand from '@oclif/plugin-update/lib/commands/update';

import { HttpToolkitServerApi } from './api-server';
import { checkBrowserConfig } from './browsers';
import { reportError } from './error-tracking';
import { ALLOWED_ORIGINS } from './constants';
import { delay, readFile, checkAccess, writeFile, ensureDirectoryExists } from './util';
import { registerShutdownHandler, addShutdownHandler } from './shutdown';
import { getTimeToCertExpiry, parseCert } from './certificates';

import { createDockerProxy } from './interceptors/docker/docker-proxy';
import { DestroyableServer } from './destroyable-server';

const APP_NAME = "HTTP Toolkit";

async function generateHTTPSConfig(configPath: string) {
    const keyPath = path.join(configPath, 'ca.key');
    const certPath = path.join(configPath, 'ca.pem');

    const [ certContent ] = await Promise.all([
        readFile(certPath, 'utf8').then((certContent) => {
            checkCertExpiry(certContent);
            return certContent;
        }),
        checkAccess(keyPath, fs.constants.R_OK),
    ]).catch(async () => {
        // Cert doesn't exist, or is too close/past expiry. Generate a new one:

        const newCertPair = await generateCACertificate({
            commonName: APP_NAME + ' CA'
        });

        return Promise.all([
            writeFile(certPath, newCertPair.cert).then(() => newCertPair.cert),
            writeFile(keyPath, newCertPair.key)
        ]);
    });

    return {
        keyPath,
        certPath,
        certContent,
        keyLength: 2048 // Reasonably secure keys please
    };
}

function checkCertExpiry(certContents: string): void {
    const remainingLifetime = getTimeToCertExpiry(parseCert(certContents));
    if (remainingLifetime < 1000 * 60 * 60 * 48) { // Next two days
        console.warn('Certificate expires soon - it must be regenerated');
        throw new Error('Certificate regeneration required');
    }
}

function pairWithInterceptingDockerProxies(
    standalone: MockttpStandalone,
    httpsConfig: { certPath: string, certContent: string }
) {
    const dockerProxies: { [port: number]: DestroyableServer } = {};

    standalone.on('mock-server-started', async (server) => {
        dockerProxies[server.port] = await createDockerProxy(server.port, httpsConfig);
    });

    standalone.on('mock-server-stopping', (server) => {
        const port = server.port;
        if (dockerProxies[port]) { // Might not exist, in some error scenarios
            dockerProxies[port].destroy();
            delete dockerProxies[port];
        }
    });

    addShutdownHandler(() => Promise.all(
        Object.values(dockerProxies).map((proxy) => proxy.destroy())
    ));
}

export async function runHTK(options: {
    configPath?: string
    authToken?: string
} = {}) {
    const startTime = Date.now();
    registerShutdownHandler();

    const configPath = options.configPath || envPaths('httptoolkit', { suffix: '' }).config;

    await ensureDirectoryExists(configPath);
    await checkBrowserConfig(configPath);

    const configCheckTime = Date.now();
    console.log('Config checked in', configCheckTime - startTime, 'ms');

    const httpsConfig = await generateHTTPSConfig(configPath);

    const certSetupTime = Date.now();
    console.log('Certificates setup in', certSetupTime - configCheckTime, 'ms');

    // Start a Mockttp standalone server
    const standalone = getStandalone({
        serverDefaults: {
            cors: false, // Don't add mocked CORS responses to intercepted traffic
            recordTraffic: false, // Don't persist traffic here (keep it in the UI)
            https: httpsConfig // Use our HTTPS config for HTTPS MITMs.
        },
        corsOptions: {
            strict: true, // For the standalone admin API, require valid CORS headers
            origin: ALLOWED_ORIGINS, // Only allow requests from our origins, to avoid XSRF
            maxAge: 86400 // Cache CORS responses for as long as possible
        }
    });
    pairWithInterceptingDockerProxies(standalone, httpsConfig);
    await standalone.start({
        port: 45456,
        host: '127.0.0.1'
    });

    const standaloneSetupTime = Date.now();
    console.log('Standalone server started in', standaloneSetupTime - certSetupTime, 'ms');

    // Start the HTK server API
    const apiServer = new HttpToolkitServerApi({
        appName: APP_NAME,
        configPath,
        authToken: options.authToken,
        https: httpsConfig
    });

    const updateMutex = new Mutex();
    apiServer.on('update-requested', () => {
        updateMutex.runExclusive(() =>
            (<Promise<void>> updateCommand.run(['stable']))
            .catch((error) => {
                // Received successful update that wants to restart the server
                if (error.code === 'EEXIT') {
                    // Block future update checks for one hour.

                    // If we don't, we'll redownload the same update again every check.
                    // We don't want to block it completely though, in case this server
                    // stays open for a very long time.
                    return delay(1000 * 60 * 60);
                }

                console.log(error);
                reportError('Failed to check for updates');
            })
        );
    });

    await apiServer.start();

    console.log('Server started in', Date.now() - standaloneSetupTime, 'ms');
    console.log('Total startup took', Date.now() - startTime, 'ms');
}