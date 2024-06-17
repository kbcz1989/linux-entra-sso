/*
 * SPDX-License-Identifier: MPL-2.0
 * SPDX-FileCopyrightText: Copyright 2024 Siemens AG
 */

let prt_sso_cookie = {
    data: {},
    hasData: false
};
let accounts = {
    registered: [],
    active: null,
    queried: false
};
let initialized = false;
let graph_api_token = null;
let state_active = true;
let broker_online = false;
let port = null;

function ssoLog(message) {
    console.log('[EntraID SSO] ' + message)
}

function ssoLogError(message) {
    console.error('[EntraID SSO] ' + message)
}

/*
 * Helpers to wait for a value to become available
 */
async function sleep (ms) {
    return new Promise(r => setTimeout(r, ms));
}
async function waitFor(f) {
    while(!f()) await sleep(200);
    return f();
};

async function load_accounts() {
    port.postMessage({'command': 'getAccounts'});
    await waitFor(() => {
        if (accounts.queried) {
            return true;
        }
        return false;
    });
    if (accounts.registered.length == 0) {
        ssoLog('no accounts registered');
        return;
    }
    accounts.active = accounts.registered[0];
    ssoLog('active account: ' + accounts.active.username);

    // load profile picture and set it as icon
    port.postMessage({'command': 'acquireTokenSilently', 'account': accounts.active});
    await waitFor(() => {return graph_api_token !== null; });
    ssoLog('API token acquired');
    const response = await fetch('https://graph.microsoft.com/v1.0/me/photos/48x48/$value', {
        headers: {
            'Content-Type': 'image/jpeg',
            'Authorization': 'Bearer ' + graph_api_token.accessToken
        }
    });
    if (response.ok) {
        let avatar = await createImageBitmap(await response.blob());
        let canvas = new OffscreenCanvas(48, 48);
        let ctx = canvas.getContext('2d');
        ctx.save();
        ctx.beginPath();
        ctx.arc(24, 24, 24, 0, Math.PI * 2, false);
        ctx.clip();
        ctx.drawImage(avatar, 0, 0);
        ctx.restore();
        chrome.action.setIcon({
            'imageData': ctx.getImageData(0, 0, 48, 48)
        });
    } else {
        ssoLog('Warning: Could not get profile picture.');
    }
    browser.action.setTitle({
        title: 'EntraID SSO: ' + accounts.active.username}
    );
}

function logout() {
    accounts.active = null;
    accounts.queried = false;
    browser.action.setIcon({
        'path': 'icons/sso-mib.svg'
    });
    let title = 'EntraID SSO disabled. Click to enable.'
    if (state_active)
        title = 'EntraID SSO disabled (waiting for broker).'
    browser.action.setTitle({title: title});
}

async function get_or_request_prt(ssoUrl) {
    ssoLog('request new PrtSsoCookie from broker for ssoUrl: ' + ssoUrl);
    port.postMessage({
        'command': 'acquirePrtSsoCookie',
        'account': accounts.active,
        'ssoUrl': ssoUrl})
    await waitFor(() => {
        if (prt_sso_cookie.hasData) {
            return true;
        }
        return false;
    })
    prt_sso_cookie.hasData = false;
    data = prt_sso_cookie.data
    if ('error' in data) {
        ssoLog('could not acquire PRT SSO cookie: ' + data.error);
    }
    return data;
}

async function on_before_send_headers(e) {
    // filter out requests that are not part of the OAuth2.0 flow
    accept = e.requestHeaders.find(header => header.name.toLowerCase() === "accept")
    if (accept === undefined || !accept.value.includes('text/html')) {
        return { requestHeaders: e.requestHeaders };
    }
    if (!broker_online || accounts.active === null) {
        return { requestHeaders: e.requestHeaders };
    }
    let prt = await get_or_request_prt(e.url);
    if ('error' in prt) {
        return { requestHeaders: e.requestHeaders };
    }
    // ms-oapxbc OAuth2 protocol extension
    ssoLog('inject PRT SSO into request headers');
    e.requestHeaders.push({"name": prt.cookieName, "value": prt.cookieContent})
    return { requestHeaders: e.requestHeaders };
}

async function on_message(response) {
    if (response.command == "acquirePrtSsoCookie") {
        prt_sso_cookie.data = response.message;
        prt_sso_cookie.hasData = true;
    } else if (response.command == "getAccounts") {
        accounts.queried = true;
        if ('error' in response) {
            ssoLog('could not get accounts: ' + response.error);
            return;
        }
        accounts.registered = response.message.accounts;
    } else if (response.command == "acquireTokenSilently") {
        if ('error' in response) {
            ssoLog('could not acquire token silently: ' + response.error);
            return;
        }
        graph_api_token = response.message.brokerTokenResponse;
    } else if (response.command == "brokerStateChanged") {
        if (!state_active)
            return;
        if (response.message == 'online') {
            ssoLog('connection to broker restored');
            broker_online = true;
            browser.action.enable();
            load_accounts();
        } else {
            ssoLog('lost connection to broker');
            broker_online = false;
            browser.action.disable();
            logout();
        }
    }
    else {
        ssoLog('unknown command: ' + response.command);
    }
}

async function on_startup() {
    ssoLog('start sso-mib');
    if (initialized) {
        ssoLog('sso-mib already initialized');
        return;
    }

    port =  browser.runtime.connectNative("sso_mib");
    browser.action.disable();
    logout();

    port.onDisconnect.addListener(() => {
        if (browser.runtime.lastError) {
            ssoLogError('Error in native application connection:' +
                browser.runtime.lastError);
        } else {
            ssoLogError('Native application connection closed.');
        }
    });

    port.onMessage.addListener(on_message);

    browser.webRequest.onBeforeSendHeaders.addListener(
        on_before_send_headers,
        { urls: ["https://login.microsoftonline.com/*"] },
        ["blocking", "requestHeaders"]
    );

    browser.action.onClicked.addListener(() => {
        state_active = !state_active;
        if (state_active && broker_online) {
            load_accounts();
        } else {
            logout();
        }
    });
    initialized = true;
}

browser.runtime.onStartup.addListener(() => {
    on_startup();
});

on_startup();
