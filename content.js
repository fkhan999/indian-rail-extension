// This runs in the extension's isolated world. We will inject the API into the page's main world
// so that you can control `window.erailSearchTrain` and `window.erailFetchCalendar` 
// from the DevTools console or other un-isolated page scripts, with absolutely no UI.

function injectErailAPI() {
    const workerPath = chrome.runtime.getURL('lib/worker.min.js');
    const corePath = chrome.runtime.getURL('lib/tesseract-core.wasm.js');

    const tsScript = document.createElement('script');
    tsScript.src = chrome.runtime.getURL('lib/tesseract.min.js');
    console.log("[eRail Content Script] Attempting to inject tesseract.min.js into the main world...");

    tsScript.onload = () => {
        console.log("[eRail Content Script] Successfully injected Tesseract. Now injecting the API...");

        // Instead of inline script, we inject an external file to comply with CSP
        const extScript = document.createElement('script');
        extScript.src = chrome.runtime.getURL('inject.js');
        // Pass necessary paths for the worker initialization
        extScript.dataset.worker = workerPath;
        extScript.dataset.core = corePath;

        document.documentElement.appendChild(extScript);
        setTimeout(() => extScript.remove(), 1000);
    };

    tsScript.onerror = (e) => {
        console.error("[eRail Content Script] CRITICAL ERROR: Could not load tesseract.min.js!", e);
        console.error("Make sure 'lib/tesseract.min.js' is added to 'web_accessible_resources' in manifest.json!");
    };

    document.documentElement.appendChild(tsScript);
}

// Initialize!
injectErailAPI();
