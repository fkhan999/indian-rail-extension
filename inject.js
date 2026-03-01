// Reusable function to solve any image using Tesseract worker

// We read them from the dataset attributes set by content.js during injection!
// We must do this immediately because content.js deletes the script tag after 1s.
const getErailExtensionPaths = () => {
    const scriptTag = document.currentScript || document.querySelector('script[src*="inject.js"]');
    if (scriptTag) {
        return {
            workerPath: scriptTag.getAttribute('data-worker'),
            corePath: scriptTag.getAttribute('data-core')
        };
    }
    return { workerPath: '', corePath: '' };
};
const erailPaths = getErailExtensionPaths();

async function fetchWithRetry(url, options = {}, retries = 3) {
    for (let i = 0; i < retries; i++) {
        try {
            const res = await fetch(url, options);
            if (!res.ok) throw new Error(`HTTP error! status: ${res.status}`);
            return res;
        } catch (err) {
            if (i === retries - 1) throw err;
            console.warn(`[eRail API] Fetch failed, retrying (${i + 1}/${retries})...`, err);
            await new Promise(r => setTimeout(r, 1000 * (i + 1))); // Incremental exponential backoff
        }
    }
}

window.erailInitTesseract = async function () {
    if (!window.tesseractWorker) {
        window.tesseractWorker = await Tesseract.createWorker("eng", 1, {
            workerPath: erailPaths.workerPath,
            corePath: erailPaths.corePath,
            logger: m => { }  // Suppress Tesseract noisy logging
        });

        // Allow numbers and math operators for solving equation captchas
        await window.tesseractWorker.setParameters({
            tessedit_char_whitelist: '0123456789+-=*xX/ ',
        });
    }
    return window.tesseractWorker;
}

window.erailSolveCaptcha = async function () {
    try {
        const configRes = await fetchWithRetry('https://www.indianrail.gov.in/enquiry/CaptchaConfig');
        const configText = await configRes.text();
        const isCaptchaNeeded = configText.trim() === '1';

        if (!isCaptchaNeeded) {
            console.log("[eRail API] CaptchaConfig returned 0. No captcha needed.");
            return '';
        }

        console.log("[eRail API] Captcha needed. Fetching captchaDraw.png...");
        const imgRes = await fetchWithRetry('https://www.indianrail.gov.in/enquiry/captchaDraw.png?' + Math.random());
        const blob = await imgRes.blob();

        const worker = await window.erailInitTesseract();
        const { data: { text } } = await worker.recognize(blob);
        console.log("[eRail API] Raw OCR Text:", text);

        let answer = '';
        // The OCR might read `63 + 30 = 7` (thinking `?` is `7`).
        // We split by '=' to only look at the left side: `63 + 30`.
        let mathText = text.split('=')[0].replace(/[xX]/g, '*').trim();

        try {
            const match = mathText.match(/(\d+)\s*([\+\-\*\/])\s*(\d+)/);
            if (match) {
                const num1 = parseInt(match[1], 10);
                const op = match[2];
                const num2 = parseInt(match[3], 10);

                if (op === '+') answer = (num1 + num2).toString();
                else if (op === '-') answer = (num1 - num2).toString();
                else if (op === '*') answer = (num1 * num2).toString();
                else if (op === '/') answer = Math.round(num1 / num2).toString();
            } else {
                // Fallback: just return digits if no operator was found
                answer = text.replace(/[^0-9]/g, '');
            }
        } catch (err) {
            console.error("[eRail API] Math eval error:", err);
            answer = text.replace(/[^0-9]/g, '');
        }

        console.log("[eRail API] Computed Math Answer:", answer);
        return answer;
    } catch (e) {
        console.error("[eRail API] Captcha Error:", e);
        return '';
    }
};

function getEncodedStationName(code) {
    let fullName = code;
    if (window.erailStations && window.erailStations.length > 0) {
        let sc = window.erailStations.find(s => s.endsWith(`- ${code}`));
        if (sc) fullName = sc;
    } else {
        // Fallbacks for testing
        if (code === 'NDLS') fullName = "NEW DELHI - NDLS";
        if (code === 'BCT') fullName = "MUMBAI CENTRAL - BCT";
    }
    return encodeURIComponent(fullName).replace(/%20/g, '+');
}

window.erailSearchTrain = async function (source, dest, date, retries = 3) {
    console.log(`[eRail API] Searching trains from ${source} to ${dest} for ${date}...`);
    const encodedSource = getEncodedStationName(source);
    const encodedDest = getEncodedStationName(dest);

    for (let i = 0; i < retries; i++) {
        const captchaText = await window.erailSolveCaptcha();
        const url = `https://www.indianrail.gov.in/enquiry/CommonCaptcha?inputPage=TBIS&sourceStation=${encodedSource}&destinationStation=${encodedDest}&dt=${date}&language=en&inputCaptcha=${captchaText}&flexiWithDate=n&_=${Date.now()}`;

        const response = await fetchWithRetry(url, {
            headers: { 'X-Requested-With': 'XMLHttpRequest' }
        });

        const data = await response.json();
        if (data && data.errorMessage && data.errorMessage.toLowerCase().includes('captcha')) {
            console.warn(`[eRail API] Captcha failed for search, retrying solve (${i + 1}/${retries})...`);
            continue;
        }

        console.log("[eRail API] Search Results:", data);
        return data;
    }
    throw new Error("Failed to solve captcha after multiple attempts");
};

window.erailFetchCalendar = async function (trainNo, classc, date, source, dest, trainType = 'S', quota = 'GN', retries = 3) {
    console.log(`[eRail API] Fetching calendar availability for ${trainNo} ${classc} (${trainType}) under ${quota} quota...`);

    for (let i = 0; i < retries; i++) {
        const captchaText = await window.erailSolveCaptcha();

        // TBIS requires padded "NAME - CODE", but TBIS_CALL_FOR_FARE requires only the raw "CODE"!
        const url = `https://www.indianrail.gov.in/enquiry/CommonCaptcha?inputPage=TBIS_CALL_FOR_FARE&trainNo=${trainNo}&dt=${date}&sourceStation=${source}&destinationStation=${dest}&classc=${classc}&quota=${quota}&traintype=${trainType}&language=en&inputCaptcha=${captchaText}&_=${Date.now()}`;

        const response = await fetchWithRetry(url, { headers: { 'X-Requested-With': 'XMLHttpRequest' } });
        const data = await response.json();

        if (data && data.errorMessage && data.errorMessage.toLowerCase().includes('captcha')) {
            console.warn(`[eRail API] Captcha failed for calendar, retrying solve (${i + 1}/${retries})...`);
            continue;
        }

        console.log("[eRail API] Calendar Matrix:", data);
        return data;
        return data;
    }
    throw new Error("Failed to solve captcha after multiple attempts");
};

window.erailCheckPNR = async function (pnr, retries = 3) {
    console.log(`[eRail API] Checking PNR Status for ${pnr}...`);
    for (let i = 0; i < retries; i++) {
        const captchaText = await window.erailSolveCaptcha();
        const url = `https://www.indianrail.gov.in/enquiry/CommonCaptcha?inputPnrNo=${pnr}&inputPage=PNR&language=en&inputCaptcha=${captchaText}&_=${Date.now()}`;

        const response = await fetchWithRetry(url, { headers: { 'X-Requested-With': 'XMLHttpRequest' } });
        const data = await response.json();

        if (data && data.errorMessage && data.errorMessage.toLowerCase().includes('captcha')) {
            console.warn(`[eRail API] Captcha failed for PNR, retrying solve (${i + 1}/${retries})...`);
            continue;
        }

        console.log("[eRail API] PNR Results:", data);
        return data;
    }
    throw new Error("Failed to solve captcha after multiple attempts");
};

window.erailCheckSchedule = async function (trainNo, trainName, retries = 3) {
    console.log(`[eRail API] Checking Schedule for Train ${trainNo}...`);
    for (let i = 0; i < retries; i++) {
        const captchaText = await window.erailSolveCaptcha();
        const fullTrainStr = encodeURIComponent(`${trainNo} - ${trainName}`);
        const url = `https://www.indianrail.gov.in/enquiry/CommonCaptcha?trainNo=${fullTrainStr}&inputPage=TRAIN_SCHEDULE&language=en&inputCaptcha=${captchaText}&_=${Date.now()}`;

        const response = await fetchWithRetry(url, { headers: { 'X-Requested-With': 'XMLHttpRequest' } });
        const data = await response.json();

        if (data && data.errorMessage && data.errorMessage.toLowerCase().includes('captcha')) {
            console.warn(`[eRail API] Captcha failed for Schedule, retrying solve (${i + 1}/${retries})...`);
            continue;
        }

        console.log("[eRail API] Schedule Results:", data);
        return data;
    }
    throw new Error("Failed to solve captcha after multiple attempts");
};

window.erailFetchFare = async function (trainNo, trainName, classc, quota, date, source, dest, retries = 3) {
    console.log(`[eRail API] Checking Fare...`);
    for (let i = 0; i < retries; i++) {
        const captchaText = await window.erailSolveCaptcha();
        const fullTrainStr = encodeURIComponent(`${trainNo} - ${trainName}`);

        // Pass strictly encoded source/dest values as required by /FARE natively
        const url = `https://www.indianrail.gov.in/enquiry/CommonCaptcha?trainNo=${fullTrainStr}&dt=${date}&sourceStation=${encodeURIComponent(source)}&destinationStation=${encodeURIComponent(dest)}&classc=${classc}&quota=${quota}&inputPage=FARE&language=en&inputCaptcha=${captchaText}&_=${Date.now()}`;

        const response = await fetchWithRetry(url, { headers: { 'X-Requested-With': 'XMLHttpRequest' } });
        const data = await response.json();

        if (data && data.errorMessage && data.errorMessage.toLowerCase().includes('captcha')) {
            console.warn(`[eRail API] Captcha failed for Fare, retrying solve (${i + 1}/${retries})...`);
            continue;
        }

        console.log("[eRail API] Fare Matrix:", data);
        return data;
    }
    throw new Error("Failed to solve captcha after multiple attempts");
};

function injectAppUI() {
    // Only inject on the index page
    if (!window.location.href.includes('index.html')) return;

    document.body.innerHTML = `
        <div id="erail-app">
            <style>
                @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap');
                
                body {
                    margin: 0;
                    padding: 0;
                    font-family: 'Inter', sans-serif;
                    background: linear-gradient(135deg, #0f2027, #203a43, #2c5364);
                    background-size: 400% 400%;
                    animation: gradientBG 15s ease infinite;
                    color: white;
                    min-height: 100vh;
                    display: flex;
                    flex-direction: column;
                    align-items: center;
                }

                @keyframes gradientBG {
                    0% { background-position: 0% 50%; }
                    50% { background-position: 100% 50%; }
                    100% { background-position: 0% 50%; }
                }

                @keyframes fadeDown {
                    from { opacity: 0; transform: translateY(-10px); }
                    to { opacity: 1; transform: translateY(0); }
                }

                .glass-card {
                    background: rgba(255, 255, 255, 0.05);
                    backdrop-filter: blur(16px);
                    -webkit-backdrop-filter: blur(16px);
                    border: 1px solid rgba(255, 255, 255, 0.1);
                    border-radius: 12px;
                    padding: 16px;
                    width: 100%;
                    box-sizing: border-box;
                    margin-top: 20px;
                    box-shadow: 0 8px 32px 0 rgba(0, 0, 0, 0.37);
                }

                .top-bar {
                    max-width: 1400px;
                    display: flex;
                    flex-direction: column;
                    gap: 12px;
                }

                .search-row {
                    display: flex;
                    flex-wrap: wrap;
                    align-items: center;
                    gap: 12px;
                    font-size: 13px;
                }

                .search-row label {
                    display: flex;
                    align-items: center;
                    gap: 6px;
                    color: #a1c4fd;
                    white-space: nowrap;
                }

                .search-row input[type="text"], 
                .search-row input[type="date"], 
                .search-row select {
                    padding: 6px 10px;
                    background: rgba(0, 0, 0, 0.3);
                    border: 1px solid rgba(255, 255, 255, 0.2);
                    border-radius: 6px;
                    color: white;
                    font-family: inherit;
                    font-size: 13px;
                    transition: border-color 0.2s;
                }

                .search-row input[type="text"] { width: 140px; }
                .search-row select { appearance: auto; background-color: #203a43; }
                .search-row input[type="date"] { width: 130px; }
                
                .search-row input:focus, .search-row select:focus {
                    outline: none;
                    border-color: #a1c4fd;
                }

                .checkbox-label {
                    cursor: pointer;
                    user-select: none;
                }
                .checkbox-label input[type="checkbox"] {
                    cursor: pointer;
                    width: 16px;
                    height: 16px;
                    accent-color: #69f0ae;
                }

                .icon-btn {
                    background: rgba(255,255,255,0.1);
                    border: 1px solid rgba(255,255,255,0.2);
                    color: white;
                    border-radius: 6px;
                    cursor: pointer;
                    padding: 4px 10px;
                    font-weight: bold;
                    transition: all 0.2s;
                    display: inline-flex;
                    align-items: center;
                    justify-content: center;
                }
                .icon-btn:hover { background: rgba(255,255,255,0.3); }

                .submit-btn {
                    padding: 8px 16px;
                    background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                    color: white;
                    border: none;
                    border-radius: 6px;
                    font-size: 14px;
                    font-weight: 600;
                    cursor: pointer;
                    transition: transform 0.2s, box-shadow 0.2s;
                }
                .submit-btn:hover {
                    box-shadow: 0 4px 12px rgba(102, 126, 234, 0.4);
                }
                .submit-btn:disabled {
                    background: #555;
                    cursor: not-allowed;
                    box-shadow: none;
                }

                .table-container {
                    max-width: 1400px;
                    overflow-x: auto;
                    margin-top: 20px;
                    padding: 0; 
                    border-radius: 12px;
                }

                .erail-table {
                    width: 100%;
                    border-collapse: collapse;
                    font-size: 13px;
                    min-width: 1000px;
                }

                .erail-table th, .erail-table td {
                    padding: 8px;
                    border-bottom: 1px solid rgba(255,255,255,0.08);
                    border-right: 1px solid rgba(255,255,255,0.05);
                    text-align: center;
                }

                .erail-table th {
                    background: rgba(0, 0, 0, 0.4);
                    color: #a1c4fd;
                    font-weight: 600;
                    position: sticky;
                    top: 0;
                    z-index: 10;
                }

                .erail-table td.text-left { text-align: left; }
                
                .class-header { cursor: pointer; text-decoration: underline; text-decoration-style: dotted; text-underline-offset: 4px; transition: background 0.2s, color 0.2s; }
                .class-header:hover { color: #fff; background: rgba(255,255,255,0.15); }

                .erail-table tr:hover {
                    background: rgba(255, 255, 255, 0.05);
                }

                /* Run days styles */
                .run-Y { color: #69f0ae; font-weight: bold; }
                .run-N { color: rgba(255,255,255,0.2); font-size: 11px; }

                /* Class cell styles */
                .class-cell {
                    background: rgba(0,0,0,0.2);
                    border-radius: 4px;
                    cursor: pointer;
                    width: 48px;
                    padding: 4px 0;
                    transition: background 0.2s;
                    font-weight: 500;
                    text-align: center;
                    box-sizing: border-box;
                    margin: 0 auto;
                }
                .class-cell:hover { background: rgba(255,255,255,0.15); }
                .class-cell.loading { opacity: 0.6; pointer-events: none; }
                .class-cell.avail { color: #69f0ae; }
                .class-cell.wl { color: #ff8a80; }
                .class-cell.rac { color: #ffd740; }
                .class-cell.empty { background: transparent; cursor: default; color: rgba(255,255,255,0.1); }

                /* Autocomplete */
                .autocomplete-items {
                    position: absolute;
                    border: 1px solid rgba(255, 255, 255, 0.1);
                    z-index: 99;
                    top: 100%;
                    left: 0;
                    background: rgba(20, 35, 45, 0.95);
                    max-height: 200px;
                    overflow-y: auto;
                    border-radius: 8px;
                    color: white;
                    font-size: 13px;
                }
                .autocomplete-items div {
                    padding: 8px 12px;
                    cursor: pointer;
                    border-bottom: 1px solid rgba(255,255,255,0.05);
                }
                .autocomplete-items div:hover { background: rgba(255,255,255,0.1); }
                .autocomplete-items strong { color: #a1c4fd; }

                .input-wrap {
                    position: relative;
                    display: inline-block;
                }

                .loading-msg {
                    text-align: center;
                    padding: 20px;
                    font-size: 14px;
                    color: #a1c4fd;
                }
            </style>

            <div class="glass-card top-bar">
                <div class="search-row">
                    <label>From 
                        <div class="input-wrap">
                            <input type="text" id="erail-src" autocomplete="off" placeholder="Loading...">
                        </div>
                    </label>
                    <button class="icon-btn" id="swap-btn" title="Swap Stations">&harr;</button>
                    <label>To 
                        <div class="input-wrap">
                            <input type="text" id="erail-dst" autocomplete="off" placeholder="Loading...">
                        </div>
                    </label>
                    
                    <button class="icon-btn" id="prev-day" title="Previous Day">←</button>
                    <input type="date" id="erail-date">
                    <button class="icon-btn" id="next-day" title="Next Day">→</button>

                    <label>Quota 
                        <select id="erail-quota">
                            <option value="GN" selected>General Quota</option>
                            <option value="TQ">Tatkal Quota</option>
                            <option value="PT">Premium Tatkal</option>
                            <option value="LD">Ladies Quota</option>
                            <option value="DF">Defence Quota</option>
                            <option value="FT">Foreign Tourist</option>
                            <option value="SS">Lower Berth</option>
                        </select>
                    </label>
                    <label>Class 
                        <select id="erail-class">
                            <option value="A">Class</option>
                            <option value="1A">1A</option>
                            <option value="2A">2A</option>
                            <option value="3A">3A</option>
                            <option value="SL">SL</option>
                            <option value="3E">3E</option>
                            <option value="CC">CC</option>
                            <option value="2S">2S</option>
                        </select>
                    </label>
                    <button class="submit-btn" id="erail-search-btn" disabled>Search Data...</button>
                    <button class="icon-btn" id="erail-reset-btn" disabled title="Reset Form" style="border-radius:6px; padding: 0 12px; font-weight: bold;">✕ Reset</button>
                    
                    <div style="display: flex; align-items: center; gap: 12px; flex-wrap: wrap;">
                        <label>PNR 
                            <div class="input-wrap">
                                <input type="text" id="erail-pnr" autocomplete="off" placeholder="10 Digit PNR..." maxlength="10" style="width: 110px;">
                            </div>
                        <button class="submit-btn" id="erail-pnr-btn" style="background: #4caf50;" disabled>Check PNR</button>
                    </div>

                    <div style="width: 100%; border-top: 1px dashed rgba(255,255,255,0.2); margin: 6px 0;"></div>
                    <div style="display: flex; align-items: center; gap: 12px; flex-wrap: wrap; width: 100%;">
                        <span style="color:#a1c4fd; font-weight:bold; font-size: 14px; margin-right: 4px;">Advanced Route Explorer</span>
                        <input type="text" id="erail-adv-train" autocomplete="off" placeholder="Train (e.g. 12555)" style="width: 130px; padding: 6px 10px; background: rgba(0,0,0,0.3); border: 1px solid rgba(255,255,255,0.2); border-radius: 6px; color: white;">
                        <input type="date" id="erail-adv-date" style="padding: 6px 10px; background: rgba(0,0,0,0.3); border: 1px solid rgba(255,255,255,0.2); border-radius: 6px; color: white;">
                        <input type="text" id="erail-adv-src" autocomplete="off" placeholder="Boarding (e.g. NDLS)" style="width: 140px; padding: 6px 10px; background: rgba(0,0,0,0.3); border: 1px solid rgba(255,255,255,0.2); border-radius: 6px; color: white;">
                        <input type="text" id="erail-adv-dst" autocomplete="off" placeholder="Dest (e.g. GKP)" style="width: 140px; padding: 6px 10px; background: rgba(0,0,0,0.3); border: 1px solid rgba(255,255,255,0.2); border-radius: 6px; color: white;">
                        <select id="erail-adv-class" style="padding: 6px 10px; background: rgba(0,0,0,0.3); border: 1px solid rgba(255,255,255,0.2); border-radius: 6px; color: white;">
                            <option value="1A">1A</option><option value="2A">2A</option><option value="3A">3A</option><option value="SL" selected>SL</option><option value="CC">CC</option><option value="2S">2S</option>
                        </select>
                        <button class="submit-btn" id="erail-adv-btn" style="background: #e91e63;" disabled>Search Extended Route</button>
                    </div>
                </div>
            </div>

            <div id="erail-loading-status" class="loading-msg">Fetching Initial Stations...</div>

            <div class="table-container glass-card" id="erail-results-container" style="display:none;">
                <table class="erail-table" id="erail-table">
                    <thead id="erail-table-head">
                        <tr>
                            <th>Train</th>
                            <th class="text-left">Train Name</th>
                            <th>From</th>
                            <th>Dep.</th>
                            <th>Date</th>
                            <th>To</th>
                            <th>Arr.</th>
                            <th>Travel</th>
                            <th title="Monday" style="color:#ffb74d">M</th>
                            <th title="Tuesday" style="color:#ffb74d">T</th>
                            <th title="Wednesday" style="color:#ffb74d">W</th>
                            <th title="Thursday" style="color:#ffb74d">T</th>
                            <th title="Friday" style="color:#ffb74d">F</th>
                            <th title="Saturday" style="color:#ffb74d">S</th>
                            <th title="Sunday" style="color:#ef5350">S</th>
                            <th class="class-header" data-cls="1A" title="Check all 1A">1A</th>
                            <th class="class-header" data-cls="2A" title="Check all 2A">2A</th>
                            <th class="class-header" data-cls="3A" title="Check all 3A">3A</th>
                            <th class="class-header" data-cls="SL" title="Check all SL">SL</th>
                            <th class="class-header" data-cls="3E" title="Check all 3E">3E</th>
                            <th class="class-header" data-cls="CC" title="Check all CC">CC</th>
                            <th class="class-header" data-cls="2S" title="Check all 2S">2S</th>
                        </tr>
                    </thead>
                    <tbody id="erail-table-body">
                        <!-- Transformed rows -->
                    </tbody>
                </table>
            </div>
        </div>
    `;

    const CLASS_COLS = ['1A', '2A', '3A', 'SL', '3E', 'CC', '2S'];

    function setupAutocomplete(inputId) {
        const inputElement = document.getElementById(inputId);
        inputElement.addEventListener("input", function (e) {
            let a, b, i, val = this.value;
            closeAllLists();
            if (!val) { return false; }

            a = document.createElement("DIV");
            a.setAttribute("id", this.id + "autocomplete-list");
            a.setAttribute("class", "autocomplete-items");

            this.parentNode.appendChild(a);

            const stations = window.erailStations || [];
            let matches = 0;
            const searchVal = val.toUpperCase();

            for (i = 0; i < stations.length; i++) {
                if (stations[i].toUpperCase().includes(searchVal)) {
                    b = document.createElement("DIV");
                    const matchIndex = stations[i].toUpperCase().indexOf(searchVal);
                    b.innerHTML = stations[i].substring(0, matchIndex);
                    b.innerHTML += "<strong>" + stations[i].substring(matchIndex, matchIndex + val.length) + "</strong>";
                    b.innerHTML += stations[i].substring(matchIndex + val.length);
                    b.innerHTML += "<input type='hidden' value='" + stations[i] + "'>";

                    b.addEventListener("click", function (e) {
                        inputElement.value = this.getElementsByTagName("input")[0].value;
                        closeAllLists();
                    });

                    a.appendChild(b);
                    matches++;
                    if (matches > 30) break;
                }
            }
        });

        function closeAllLists(elmnt) {
            var x = document.getElementsByClassName("autocomplete-items");
            for (var i = x.length - 1; i >= 0; i--) {
                if (elmnt != x[i] && elmnt != inputElement) {
                    x[i].parentNode.removeChild(x[i]);
                }
            }
        }
        document.addEventListener("click", function (e) { closeAllLists(e.target); });
    }

    async function loadStations() {
        try {
            const url = `https://www.indianrail.gov.in/enquiry/FetchAutoComplete?_=${Date.now()}`;
            const res = await fetchWithRetry(url);
            window.erailStations = await res.json();

            document.getElementById('erail-src').placeholder = "NDLS";
            document.getElementById('erail-dst').placeholder = "GHY";
            const btn = document.getElementById('erail-search-btn');
            const resetBtn = document.getElementById('erail-reset-btn');
            const pnrBtn = document.getElementById('erail-pnr-btn');
            const advBtn = document.getElementById('erail-adv-btn');
            btn.disabled = false;
            resetBtn.disabled = false;
            pnrBtn.disabled = false;
            advBtn.disabled = false;
            btn.innerText = "Get Trains";
            pnrBtn.innerText = "Check PNR";
            document.getElementById('erail-loading-status').style.display = 'none';

            setupAutocomplete('erail-src');
            setupAutocomplete('erail-dst');
            setupAutocomplete('erail-adv-src');
            setupAutocomplete('erail-adv-dst');

            const savedSrc = localStorage.getItem('erail-saved-src');
            const savedDst = localStorage.getItem('erail-saved-dst');
            const savedDate = localStorage.getItem('erail-saved-date');

            if (savedSrc) document.getElementById('erail-src').value = savedSrc;
            if (savedDst) document.getElementById('erail-dst').value = savedDst;

            if (savedDate) {
                document.getElementById('erail-date').value = savedDate;
            } else {
                const tomorrow = new Date();
                tomorrow.setDate(tomorrow.getDate() + 1);

                // Format YYYY-MM-DD for native input date
                const mm = String(tomorrow.getMonth() + 1).padStart(2, '0');
                const dd = String(tomorrow.getDate()).padStart(2, '0');
                const yyyy = tomorrow.getFullYear();

                document.getElementById('erail-date').value = `${yyyy}-${mm}-${dd}`;
                document.getElementById('erail-adv-date').value = `${yyyy}-${mm}-${dd}`;
            }

        } catch (e) {
            console.error("[eRail API] Error loading stations", e);
            document.getElementById('erail-loading-status').innerText = "Failed to load station list.";
        }
    }

    loadStations();

    // Advanced Route Search Extension
    const advBtn = document.getElementById('erail-adv-btn');
    if (advBtn) {
        advBtn.addEventListener('click', async () => {
            if (advBtn.disabled || advBtn.classList.contains('loading')) return;

            const trainRaw = document.getElementById('erail-adv-train').value.trim();
            const bRaw = document.getElementById('erail-adv-src').value.trim();
            const cRaw = document.getElementById('erail-adv-dst').value.trim();
            const dateRaw = document.getElementById('erail-adv-date').value;
            const cls = document.getElementById('erail-adv-class').value;
            const quota = document.getElementById('erail-quota').value; // Utilize current global dropdown quota

            if (!trainRaw || !bRaw || !cRaw || !dateRaw) return alert("Please fill Train, Boarding, Destination, and Date parameters for Advanced Search");

            const extractCode = (raw) => raw.includes('-') ? raw.split('-')[1].trim().toUpperCase() : raw.toUpperCase();
            const B = extractCode(bRaw);
            const C = extractCode(cRaw);
            const trainNo = extractCode(trainRaw);

            const [y, m, d] = dateRaw.split('-');
            const userDateFormatted = `${d}-${m}-${y}`;

            advBtn.innerText = "Searching...";
            advBtn.classList.add('loading');

            // Inject the advanced results DOM directly underneath the main card
            let resDiv = document.getElementById('erail-adv-results');
            if (!resDiv) {
                resDiv = document.createElement('div');
                resDiv.id = 'erail-adv-results';
                resDiv.className = 'glass-card';
                resDiv.style.marginTop = '12px';

                const topBarContainer = document.querySelector('.top-bar').parentNode;
                topBarContainer.insertBefore(resDiv, document.getElementById('erail-loading-status'));
            }

            resDiv.innerHTML = `<div style="color: #a1c4fd; font-weight: 500;">🔍 Locating actual sequence definitions for train ${trainNo}...</div>`;
            resDiv.style.display = 'block';

            try {
                // Determine Train internal specifications mapping by checking B->C base trace
                const srchData = await window.erailSearchTrain(B, C, userDateFormatted);
                const trainList = srchData.trainBtwnStnsList || [];
                const altTrainList = srchData.alternateTrainBtwnStnsList || [];
                const t = [...trainList, ...altTrainList].find(x => (x.trainNumber || x.trainNo) == trainNo);

                if (!t) {
                    resDiv.innerHTML = `<div style="color: #ff8a80; padding:12px;">❌ Train <strong>${trainNo}</strong> does not run between ${B} and ${C} directly on ${userDateFormatted}. Please verify inputs.</div>`;
                    advBtn.innerText = "Search Extended Route";
                    advBtn.classList.remove('loading');
                    return;
                }

                const trainName = t.trainName;
                const trainType = t.trainType ? (Array.isArray(t.trainType) ? t.trainType[0] : t.trainType) : 'S';

                let journeyDateObj = new Date(dateRaw);
                if (t.journeyDate) journeyDateObj = new Date(t.journeyDate);
                if (isNaN(journeyDateObj)) journeyDateObj = new Date(dateRaw);

                const jDay = String(journeyDateObj.getDate()).padStart(2, '0');
                const jMon = String(journeyDateObj.getMonth() + 1).padStart(2, '0');
                const jYear = journeyDateObj.getFullYear();
                const baseDate = `${jDay}-${jMon}-${jYear}`;

                resDiv.innerHTML = `<div style="color: #a1c4fd; font-weight: 500;">🚉 Synchronizing master schedule path for ${trainNo} - ${trainName}...</div>`;

                const schData = await window.erailCheckSchedule(trainNo, trainName);
                if (schData.errorMessage) throw new Error(schData.errorMessage);

                let A_idx = 0;
                let D_idx = schData.stationList ? schData.stationList.length - 1 : 0;
                let B_idx = schData.stationList ? schData.stationList.findIndex(s => s.stationCode === B) : 0;
                let C_idx = schData.stationList ? schData.stationList.findIndex(s => s.stationCode === C) : 0;

                if (B_idx === -1) B_idx = 0;
                if (C_idx === -1) C_idx = D_idx;

                let A = B;
                let D = C;
                if (schData.stationList && schData.stationList.length > 0) {
                    A = schData.stationList[A_idx].stationCode;
                    D = schData.stationList[D_idx].stationCode;
                }

                resDiv.innerHTML = `<div style="color: #a1c4fd; font-weight: 500;">🔄 Performing intelligent backward traceback to find closest origin boundary for cheapest fare...</div>`;

                const results = [];

                const getqDate = (idxSrc) => {
                    if (idxSrc === A_idx) return baseDate;
                    let dayB = parseInt(schData.stationList[B_idx].dayCount || 1);
                    let daySrc = parseInt(schData.stationList[idxSrc].dayCount || 1);
                    let offset = daySrc - dayB;
                    let [d, m, y] = userDateFormatted.split('-');
                    let dateObj = new Date(parseInt(y), parseInt(m) - 1, parseInt(d));
                    if (isNaN(dateObj)) return userDateFormatted;
                    dateObj.setDate(dateObj.getDate() + offset);
                    return `${String(dateObj.getDate()).padStart(2, '0')}-${String(dateObj.getMonth() + 1).padStart(2, '0')}-${dateObj.getFullYear()}`;
                };

                const checkRoute = async (idxSrc, idxDst, label, isDirect = false) => {
                    if (idxSrc >= idxDst) return null;
                    let segSrc = schData.stationList[idxSrc].stationCode;
                    let segDst = schData.stationList[idxDst].stationCode;

                    let exist = results.find(r => r.src === segSrc && r.dst === segDst);
                    if (exist) return exist;

                    resDiv.innerHTML = `<div style="color: #a1c4fd; font-weight: 500;">🔎 Binary Search Probe: <strong>${segSrc} → ${segDst}</strong>...</div>`;
                    let qDate = getqDate(idxSrc);

                    try {
                        const cal = await window.erailFetchCalendar(trainNo, cls, qDate, segSrc, segDst, trainType, quota);
                        let status = 'Not Available';
                        let isAvail = false;

                        if (cal && cal.avlDayList && cal.avlDayList.length > 0) {
                            const firstDay = cal.avlDayList[0];
                            status = firstDay.availablityStatus || firstDay.currentBkgFlag || firstDay.reason || 'NA';
                            if (status.includes('AVAILABLE-')) status = status.replace('AVAILABLE-', '');
                            if (status.includes('AVAILABLE') || !isNaN(status)) isAvail = true;
                        }

                        let resObj = { src: segSrc, dst: segDst, label, isDirect, status, isAvail, idxSrc, idxDst };
                        results.push(resObj);
                        await new Promise(r => setTimeout(r, 600)); // Stagger DDOS limits
                        return resObj;
                    } catch (e) {
                        let resObj = { src: segSrc, dst: segDst, label, isDirect, status: 'Error', isAvail: false, idxSrc, idxDst };
                        results.push(resObj);
                        await new Promise(r => setTimeout(r, 600));
                        return resObj;
                    }
                };

                // Tracing core
                let bcRes = await checkRoute(B_idx, C_idx, `Direct Input (${B} → ${C})`, true);

                const binarySearchBackwards = async (idxDst, isTerm) => {
                    let tgtCode = schData.stationList[idxDst].stationCode;
                    let typeLbl = isTerm ? 'Terminus' : 'Dest';

                    let L = A_idx;
                    let R = B_idx - 1;
                    if (R < L) return;

                    let aRes = await checkRoute(L, idxDst, `Origin to ${typeLbl} (${A} → ${tgtCode})`);
                    if (!aRes || !aRes.isAvail) return; // If the master origin trace itself is blocked, front portion is fully blocked, immediately prune!

                    let left = L + 1;
                    let right = R;
                    while (left <= right) {
                        let mid = Math.floor((left + right) / 2);
                        let midCode = schData.stationList[mid].stationCode;
                        let mRes = await checkRoute(mid, idxDst, `Topological Search Backward (${midCode} → ${tgtCode})`);

                        if (mRes && mRes.isAvail) {
                            left = mid + 1; // It's available! Continue pushing boundary deeper towards Boarding [B] to physically shorten track Distance
                        } else {
                            right = mid - 1; // Waitlisted. Pull boundary backwards to Origin [A] to find availability
                        }
                    }
                };

                const binarySearchForwards = async (idxSrc, isOrigin) => {
                    let srcCode = schData.stationList[idxSrc].stationCode;
                    let typeLbl = isOrigin ? 'Origin' : 'Boarding';

                    let L = C_idx + 1;
                    let R = D_idx;
                    if (R < L) return;

                    let dRes = await checkRoute(idxSrc, R, `${typeLbl} to Terminus (${srcCode} → ${D})`);
                    if (!dRes || !dRes.isAvail) return; // If terminus trace is blocked, forward portion is blocked

                    let left = L;
                    let right = R - 1;
                    while (left <= right) {
                        let mid = Math.floor((left + right) / 2);
                        let midCode = schData.stationList[mid].stationCode;
                        let mRes = await checkRoute(idxSrc, mid, `Topological Search Forward (${srcCode} → ${midCode})`);

                        if (mRes && mRes.isAvail) {
                            right = mid - 1; // It's available! Pull boundary closer to Destination C to find cheaper
                        } else {
                            left = mid + 1; // Waitlisted. Push boundary forwards to Terminus D
                        }
                    }
                };

                // Tracing Execution Logic 
                if (bcRes && !bcRes.isAvail) {

                    // 1. Try to push Origin boundary forward towards Boarding (A -> C, or Bagaha -> C)
                    await binarySearchBackwards(C_idx, false);

                    // 2. Try to push Destination boundary backwards towards Dest (B -> D, or B -> E)
                    await binarySearchForwards(B_idx, false);

                    // If neither primary trace succeeded, test full ultimate traces as last resort
                    const anyAvail = results.some(r => r.isAvail && !r.isDirect);
                    if (!anyAvail) {
                        // 3. Try to push Origin trace towards Terminus
                        await binarySearchBackwards(D_idx, true);

                        // 4. Try from Master Origin to intermediate Dest
                        await binarySearchForwards(A_idx, true);
                    }
                }

                // Compile View output
                const baseResult = results.find(r => r.src === B && r.dst === C);

                let html = `
                    <div style="font-size: 15px; font-weight: 600; margin-bottom: 12px; color: #fff; padding-bottom: 8px; border-bottom: 1px solid rgba(255,255,255,0.1);">
                        🛡️ Expansion Traces for: ${trainNo} ${trainName} (${cls}) on ${userDateFormatted}
                    </div>
                    <div style="display: flex; gap: 12px; flex-wrap: wrap; margin-bottom: 16px;">
                `;

                results.forEach(r => {
                    const bgColor = r.isAvail ? 'rgba(105, 240, 174, 0.1)' : 'rgba(255,255,255,0.05)';
                    const color = r.isAvail ? '#69f0ae' : (r.status.includes('WL') ? '#ff8a80' : '#ffd740');
                    const bColor = r.isAvail ? '#69f0ae' : 'rgba(255,255,255,0.1)';
                    const focusOutline = r.isDirect ? 'box-shadow: 0 0 10px rgba(0,0,0,0.5); border: 2px solid #a1c4fd;' : `border: 1px solid ${bColor};`;

                    html += `
                        <div style="background: ${bgColor}; ${focusOutline} padding: 12px 16px; border-radius: 8px; flex: 1; min-width: 200px;">
                            <div style="font-size: 11px; color:#8892b0; margin-bottom: 6px;">${r.label}</div>
                            <div style="font-weight: bold; color: ${color}; font-size: 16px;">${r.status}</div>
                        </div>
                    `;
                });

                html += `</div>`;
                resDiv.innerHTML = html;

                // Calculate the Pro Tip logic and find the geometrically cheapest option
                const betterAvails = results.filter(r => r.isAvail && !r.isDirect);

                if (baseResult && !baseResult.isAvail && betterAvails.length > 0) {
                    // Inject a temporary loading message for the Fare Optimization process
                    resDiv.insertAdjacentHTML('beforeend', `<div id="adv-fare-calc" style="color: #ffd740; font-weight: 500; font-size: 13px; margin-bottom: 8px;">⏳ Finding the shortest track distance...</div>`);

                    let bestAvail = null;
                    let shortestDistance = Infinity;

                    // Compute cheapest route instantly without API calls by measuring literal topological station array indices
                    for (let av of betterAvails) {
                        let idx1 = schData.stationList.findIndex(s => s.stationCode === av.src);
                        let idx2 = schData.stationList.findIndex(s => s.stationCode === av.dst);

                        // If a node is completely missing from the schedule for some reason, penalize it heavily
                        if (idx1 === -1) idx1 = 0;
                        if (idx2 === -1) idx2 = 1000;

                        let trackDistance = Math.abs(idx2 - idx1);

                        if (trackDistance < shortestDistance) {
                            shortestDistance = trackDistance;
                            bestAvail = av;
                        }
                    }

                    if (!bestAvail) bestAvail = betterAvails[0];

                    let bestFare = Infinity;
                    try {
                        // We strictly only need to ask the server for the price of the actual proven shortest viable route
                        const fullSrcObj = schData.stationList.find(s => s.stationCode === bestAvail.src);
                        const fullDstObj = schData.stationList.find(s => s.stationCode === bestAvail.dst);
                        const fullSrcName = fullSrcObj ? `${fullSrcObj.stationName} - ${fullSrcObj.stationCode}` : bestAvail.src;
                        const fullDstName = fullDstObj ? `${fullDstObj.stationName} - ${fullDstObj.stationCode}` : bestAvail.dst;

                        // IMPORTANT: The /FARE backend completely rejects queries for intermediate stops 
                        // if you don't supply the master originating journey date.
                        const fData = await window.erailFetchFare(trainNo, trainName, cls, quota, baseDate, fullSrcName, fullDstName);
                        bestFare = fData.totalFare || Infinity;
                    } catch (e) {
                        console.error('[eRail API] Optimization block missed Fare parse', e);
                    }

                    const loadingCalc = document.getElementById('adv-fare-calc');
                    if (loadingCalc) loadingCalc.remove();

                    let fareText = bestFare !== Infinity ? ` for just <strong>₹${bestFare}</strong>` : ``;

                    resDiv.insertAdjacentHTML('beforeend', `
                        <div style="background: rgba(105, 240, 174, 0.15); border: 1px dashed #69f0ae; padding: 14px; border-radius: 8px; color: #69f0ae; font-size: 14px; line-height: 1.5; animation: fadeDown 0.3s ease;">
                            <strong>💡 Optimal Strategy Tip! Availability found behind path walls!</strong><br>
                            The smartest, cheapest available ticket is explicitly from <strong>${bestAvail.src} to ${bestAvail.dst}</strong>${fareText}! 
                            You can safely book this exact longer ticket block right now, but you MUST change the <strong style="color: #fff; background: rgba(0,0,0,0.3); padding: 2px 6px; border-radius: 4px;">Boarding Point</strong> to <strong style="color: #fff;">${B}</strong> on the passenger page later to avoid a No-Show!
                        </div>
                    `);
                } else if (baseResult && baseResult.isAvail) {
                    resDiv.insertAdjacentHTML('beforeend', `
                        <div style="background: rgba(161, 196, 253, 0.1); padding: 12px; border-radius: 8px; color: #a1c4fd; font-size: 13px;">
                            The direct requested route is already natively Available. You can book it directly without extending the trace loop!
                        </div>
                    `);
                }

            } catch (e) {
                resDiv.innerHTML = `<div style="color: #ff8a80; padding:12px;">❌ Route Expansion Error: ${e.message}</div>`;
            } finally {
                advBtn.innerText = "Search Extended Route";
                advBtn.classList.remove('loading');
            }
        });
    }

    const searchBtn = document.getElementById('erail-search-btn');
    if (searchBtn) {
        searchBtn.addEventListener('click', async () => {
            let srcRaw = document.getElementById('erail-src').value.trim();
            let dstRaw = document.getElementById('erail-dst').value.trim();
            let dateRaw = document.getElementById('erail-date').value;

            if (!srcRaw || !dstRaw || !dateRaw) return alert("Please fill From, To, and Date");

            localStorage.setItem('erail-saved-src', srcRaw);
            localStorage.setItem('erail-saved-dst', dstRaw);
            localStorage.setItem('erail-saved-date', dateRaw);

            const extractCode = (raw) => {
                if (raw.includes('-')) return raw.split('-')[1].trim().toUpperCase();
                return raw.toUpperCase();
            };

            const src = extractCode(srcRaw);
            const dst = extractCode(dstRaw);

            const [y, m, d] = dateRaw.split('-');
            const dateFormatted = `${d}-${m}-${y}`;

            const statusMsg = document.getElementById('erail-loading-status');
            const tbody = document.getElementById('erail-table-body');
            const thead = document.getElementById('erail-table-head');
            const container = document.getElementById('erail-results-container');

            statusMsg.style.display = 'block';
            statusMsg.innerText = "Solving Captcha & Fetching Trains...";
            container.style.display = 'none';
            tbody.innerHTML = '';

            // Restore regular top header layout for train searches
            thead.innerHTML = `
                <tr>
                    <th>Train</th>
                    <th class="text-left">Train Name</th>
                    <th>From</th>
                    <th>Dep.</th>
                    <th>Date</th>
                    <th>To</th>
                    <th>Arr.</th>
                    <th>Travel</th>
                    <th title="Monday" style="color:#ffb74d">M</th>
                    <th title="Tuesday" style="color:#ffb74d">T</th>
                    <th title="Wednesday" style="color:#ffb74d">W</th>
                    <th title="Thursday" style="color:#ffb74d">T</th>
                    <th title="Friday" style="color:#ffb74d">F</th>
                    <th title="Saturday" style="color:#ffb74d">S</th>
                    <th title="Sunday" style="color:#ef5350">S</th>
                    <th class="class-header" data-cls="1A" title="Check all 1A">1A</th>
                    <th class="class-header" data-cls="2A" title="Check all 2A">2A</th>
                    <th class="class-header" data-cls="3A" title="Check all 3A">3A</th>
                    <th class="class-header" data-cls="SL" title="Check all SL">SL</th>
                    <th class="class-header" data-cls="3E" title="Check all 3E">3E</th>
                    <th class="class-header" data-cls="CC" title="Check all CC">CC</th>
                    <th class="class-header" data-cls="2S" title="Check all 2S">2S</th>
                </tr>
            `;

            try {
                const data = await window.erailSearchTrain(src, dst, dateFormatted);
                const trainList = data.trainBtwnStnsList || [];
                const altTrainList = data.alternateTrainBtwnStnsList || [];
                const allTrains = [...trainList, ...altTrainList];

                if (allTrains.length === 0) {
                    statusMsg.innerText = "No trains found for this route and date.";
                    return;
                }

                allTrains.forEach((t, index) => {
                    try {
                        const trainNumber = t.trainNumber || t.trainNo || 'N/A';
                        const trainName = t.trainName || 'Unknown Train';
                        const fromStnCode = t.fromStnCode || t.sourceStation || 'N/A';
                        const toStnCode = t.toStnCode || t.destinationStation || 'N/A';
                        const departureTime = t.departureTime || 'N/A';
                        const arrivalTime = t.arrivalTime || 'N/A';
                        const duration = t.duration || 'N/A';

                        const avl = t.avlClasses || t.availableClasses || (typeof t.acClasses === 'string' ? t.acClasses.split(',') : []) || [];
                        const tr = document.createElement('tr');

                        const rd = {
                            M: t.runningMon || 'N',
                            T: t.runningTue || 'N',
                            W: t.runningWed || 'N',
                            Th: t.runningThu || 'N',
                            F: t.runningFri || 'N',
                            S: t.runningSat || 'N',
                            Su: t.runningSun || 'N'
                        };
                        console.log("Train Object:", t);

                        let rowDate = dateFormatted;
                        const dateKey = t.journeyDate || t.trainDate || t.trainStartDate || t.departureDate || t.date;
                        if (dateKey) {
                            if (dateKey.includes(',')) {
                                // Handle string format "Mar 4, 2026 12:00:00 AM"
                                const dObj = new Date(dateKey);
                                if (!isNaN(dObj)) {
                                    const dd = String(dObj.getDate()).padStart(2, '0');
                                    const mm = String(dObj.getMonth() + 1).padStart(2, '0');
                                    const yyyy = dObj.getFullYear();
                                    rowDate = `${dd}-${mm}-${yyyy}`;
                                }
                            } else {
                                // Convert possible "YYYY-MM-DD" or "DD/MM/YYYY" or "DD-MM-YYYY" string
                                const raw = dateKey.toString().replace(/\//g, '-');
                                const segments = raw.split('-');
                                if (segments.length === 3) {
                                    // If format is YYYY-MM-DD
                                    if (segments[0].length === 4) {
                                        rowDate = `${segments[2]}-${segments[1]}-${segments[0]}`;
                                    } else {
                                        rowDate = `${segments[0]}-${segments[1]}-${segments[2]}`;
                                    }
                                } else {
                                    rowDate = raw;
                                }
                            }
                        }

                        const depDateMatch = rowDate.substring(0, 5);
                        const dayRender = (v) => v === 'Y' || v === '1' ? '<span class="run-Y">Y</span>' : '<span class="run-N">x</span>';

                        const html = `
                            <td class="train-no-cell" style="color:#a1c4fd; font-weight:bold; cursor:pointer; text-decoration:underline; text-decoration-style:dotted;" title="View Schedule">${trainNumber}</td>
                            <td class="text-left">${trainName}</td>
                            <td>${fromStnCode}</td>
                            <td>${departureTime}</td>
                            <td>${depDateMatch}</td>
                            <td>${toStnCode}</td>
                            <td>${arrivalTime}</td>
                            <td>${duration}</td>
                            <td>${dayRender(rd.M)}</td>
                            <td>${dayRender(rd.T)}</td>
                            <td>${dayRender(rd.W)}</td>
                            <td>${dayRender(rd.Th)}</td>
                            <td>${dayRender(rd.F)}</td>
                            <td>${dayRender(rd.S)}</td>
                            <td>${dayRender(rd.Su)}</td>
                        `;

                        tr.innerHTML = html;

                        CLASS_COLS.forEach(cls => {
                            const td = document.createElement('td');
                            if (avl.includes(cls)) {
                                const div = document.createElement('div');
                                div.className = 'class-cell';
                                div.dataset.cls = cls;
                                div.innerText = 'Check';
                                div.title = 'Check ' + cls;

                                div._fetchData = async () => {
                                    if (div.classList.contains('loading')) return;
                                    div.classList.add('loading');
                                    div.innerText = '...';

                                    const quota = document.getElementById('erail-quota').value;
                                    const trType = t.trainType ? (Array.isArray(t.trainType) ? t.trainType[0] : t.trainType) : 'S';

                                    // --- Expand Row Logic ---
                                    let expandRow = document.getElementById(`expand-${trainNumber}-${index}-${cls}`);
                                    if (!expandRow) {
                                        expandRow = document.createElement('tr');
                                        expandRow.id = `expand-${trainNumber}-${index}-${cls}`;
                                        tr.parentNode.insertBefore(expandRow, tr.nextSibling);
                                    }

                                    expandRow.innerHTML = `
                                    <td colspan="22" style="padding: 0; border: none; max-width: 0;">
                                        <div style="background: rgba(0, 0, 0, 0.4); border-top: 1px solid rgba(255,255,255,0.05); padding: 12px 16px; display: flex; align-items: center; gap: 12px; overflow-x: auto; animation: fadeDown 0.3s ease; box-sizing: border-box; width: 100%;">
                                            <div style="font-weight: 600; color: #a1c4fd; min-width: max-content;">
                                                🚄 ${trainNumber} - ${cls} Quota:
                                            </div>
                                            <div class="days-container" style="display: flex; gap: 12px;"></div>
                                            <button class="icon-btn load-more-btn" style="flex-shrink: 0; white-space: nowrap; font-size: 11px;"> 6 Days</button>
                                            <div style="flex-grow: 1;"></div>
                                            <button class="icon-btn" style="flex-shrink: 0; border-radius: 50%; width: 28px; height: 28px; padding: 0; margin-left: auto;" onclick="this.closest('tr').remove()" title="Close">✕</button>
                                        </div>
                                    </td>
                                `;

                                    const daysContainer = expandRow.querySelector('.days-container');
                                    const loadMoreBtn = expandRow.querySelector('.load-more-btn');

                                    const fetchAndRenderAvail = async (fetchDate, isLoadMore) => {
                                        try {
                                            if (isLoadMore) loadMoreBtn.innerText = "Loading...";

                                            const cal = await window.erailFetchCalendar(trainNumber, cls, fetchDate, fromStnCode, toStnCode, trType, quota);

                                            if (cal && cal.avlDayList && cal.avlDayList.length > 0) {
                                                if (!isLoadMore) {
                                                    const firstDay = cal.avlDayList[0];
                                                    let status = firstDay.availablityStatus || firstDay.currentBkgFlag || firstDay.reason || 'NA';

                                                    if (status.includes('AVAILABLE-')) status = status.replace('AVAILABLE-', '');
                                                    else if (status === 'REGRET') status = 'REGRET';

                                                    div.innerText = 'Check';
                                                    div.classList.remove('loading', 'avail', 'wl', 'rac');

                                                    if (status.includes('AVAILABLE') || !isNaN(status)) div.classList.add('avail');
                                                    else if (status.includes('WL')) div.classList.add('wl');
                                                    else if (status.includes('RAC')) div.classList.add('rac');
                                                }

                                                cal.avlDayList.forEach(day => {
                                                    let s = day.availablityStatus || day.currentBkgFlag || day.reason || 'NA';
                                                    let sc = '';
                                                    if (s.includes('AVAILABLE-')) s = s.replace('AVAILABLE-', '');
                                                    if (s.includes('AVAILABLE') || !isNaN(s)) sc = 'color: #69f0ae;';
                                                    else if (s.includes('WL')) sc = 'color: #ff8a80;';
                                                    else if (s.includes('RAC')) sc = 'color: #ffd740;';

                                                    daysContainer.insertAdjacentHTML('beforeend', `
                                                <div style="background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.08); padding: 8px 12px; border-radius: 8px; min-width: 90px; text-align: center; display:flex; flex-direction:column; gap:4px; flex-shrink: 0;">
                                                    <span style="font-size: 11px; color: #8892b0; font-weight: 500;">${day.availablityDate}</span>
                                                    <span style="font-weight: 700; font-size: 13px; ${sc}">${s}</span>
                                                </div>`);
                                                });

                                                const lastDateStr = cal.avlDayList[cal.avlDayList.length - 1].availablityDate;
                                                if (lastDateStr && lastDateStr.includes('-')) {
                                                    const parts = lastDateStr.split('-');
                                                    let yyyy, mm, dd;
                                                    if (parts[0].length === 4) [yyyy, mm, dd] = parts;
                                                    else[dd, mm, yyyy] = parts;

                                                    let fullYear = parseInt(yyyy, 10);
                                                    if (fullYear < 100) fullYear += 2000;

                                                    const nextDateObj = new Date(fullYear, parseInt(mm, 10) - 1, parseInt(dd, 10));

                                                    const runDays = [
                                                        t.runningSun, t.runningMon, t.runningTue, t.runningWed,
                                                        t.runningThu, t.runningFri, t.runningSat
                                                    ].map(v => v === 'Y' || v === '1');
                                                    const hasRunningDay = runDays.some(Boolean);

                                                    do {
                                                        nextDateObj.setDate(nextDateObj.getDate() + 1);
                                                    } while (hasRunningDay && !runDays[nextDateObj.getDay()]);

                                                    const nextDd = String(nextDateObj.getDate()).padStart(2, '0');
                                                    const nextMm = String(nextDateObj.getMonth() + 1).padStart(2, '0');
                                                    const nextDateToFetch = `${nextDd}-${nextMm}-${nextDateObj.getFullYear()}`;

                                                    loadMoreBtn.innerText = "Load More Days";
                                                    loadMoreBtn.onclick = () => fetchAndRenderAvail(nextDateToFetch, true);
                                                } else {
                                                    loadMoreBtn.style.display = 'none';
                                                }
                                            } else {
                                                if (!isLoadMore) {
                                                    div.innerText = 'Check';
                                                    div.classList.remove('loading');
                                                    loadMoreBtn.style.display = 'none';
                                                    daysContainer.innerHTML = '<span style="color:#ff8a80;font-size:13px;">No availability data.</span>';
                                                } else {
                                                    loadMoreBtn.innerText = "No more data";
                                                    loadMoreBtn.disabled = true;
                                                }
                                            }
                                        } catch (err) {
                                            if (!isLoadMore) {
                                                div.innerText = 'Check';
                                                div.title = err.message;
                                                div.classList.remove('loading');
                                                loadMoreBtn.style.display = 'none';
                                                daysContainer.innerHTML = `<span style="color:#ff8a80;font-size:13px;">Error: ${err.message}</span>`;
                                            } else {
                                                loadMoreBtn.innerText = "Error loading";
                                            }
                                        }
                                    };

                                    await fetchAndRenderAvail(rowDate, false);
                                };

                                div.addEventListener('click', div._fetchData);
                                td.appendChild(div);
                            } else {
                                td.innerHTML = '<div class="class-cell empty">x</div>';
                            }
                            tr.appendChild(td);
                        });

                        // Schedule Click Handler
                        const trainNoCell = tr.querySelector('.train-no-cell');
                        if (trainNoCell) {
                            trainNoCell.addEventListener('click', async () => {
                                let expandRow = document.getElementById(`schedule-${trainNumber}-${index}`);
                                if (expandRow) {
                                    expandRow.remove();
                                    return; // Toggle hide
                                }

                                expandRow = document.createElement('tr');
                                expandRow.id = `schedule-${trainNumber}-${index}`;
                                tr.parentNode.insertBefore(expandRow, tr.nextSibling);

                                expandRow.innerHTML = `
                                <td colspan="22" style="padding: 0; border: none; max-width: 0;">
                                    <div style="background: rgba(0, 0, 0, 0.4); border-top: 1px solid rgba(255,255,255,0.05); padding: 12px 16px; animation: fadeDown 0.3s ease; box-sizing: border-box; width: 100%;">
                                        <div style="font-weight: 600; color: #a1c4fd; margin-bottom: 8px;">
                                            🕒 Loading Schedule for ${trainNumber} - ${trainName}...
                                        </div>
                                    </div>
                                </td>`;

                                try {
                                    const quota = document.getElementById('erail-quota').value;
                                    const reqDate = document.getElementById('erail-date').value;

                                    // Fetch Schedule Data FIRST to get actual full station names for precise Fare requests
                                    const schData = await window.erailCheckSchedule(trainNumber, trainName);

                                    if (schData.errorMessage) {
                                        expandRow.innerHTML = `<td colspan="22" style="padding: 12px; color: #ff8a80; background: rgba(0,0,0,0.4);">❌ Schedule Error: ${schData.errorMessage}</td>`;
                                        return;
                                    }

                                    let fullSourceName = fromStnCode;
                                    let fullDestName = toStnCode;

                                    if (schData && schData.stationList) {
                                        const srcStn = schData.stationList.find(s => s.stationCode === fromStnCode);
                                        const dstStn = schData.stationList.find(s => s.stationCode === toStnCode);
                                        // The FARE endpoint strictly requires "NAME - CODE"
                                        if (srcStn) fullSourceName = `${srcStn.stationName} - ${srcStn.stationCode}`;
                                        if (dstStn) fullDestName = `${dstStn.stationName} - ${dstStn.stationCode}`;
                                    }

                                    // The IRCTC FARE endpoint specifically demands the date the train starts its journey (t.journeyDate), 
                                    // rather than the global date the user searched, since the train might depart its origin at midnight on an offset date.
                                    let actualDateObj;
                                    if (t.journeyDate) {
                                        actualDateObj = new Date(t.journeyDate);
                                    } else {
                                        actualDateObj = new Date(reqDate);
                                    }

                                    if (isNaN(actualDateObj)) actualDateObj = new Date(reqDate); // fallback sanity check

                                    let exactDateFormatted = `${String(actualDateObj.getDate()).padStart(2, '0')}-${String(actualDateObj.getMonth() + 1).padStart(2, '0')}-${actualDateObj.getFullYear()}`;

                                    // Sequentially fetch API calls for every single available active class to respect rate limits
                                    const fareResults = [];
                                    for (let i = 0; i < avl.length; i++) {
                                        const cls = avl[i];
                                        try {
                                            // Pass the fully formatted station name (NAME - CODE) and exact journey Date!
                                            const fareData = await window.erailFetchFare(trainNumber, trainName, cls, quota, exactDateFormatted, fullSourceName, fullDestName);
                                            fareResults.push(fareData);
                                        } catch (e) {
                                            fareResults.push({ error: true, class: cls });
                                        }
                                        // Add a 500ms delay between fare requests, except after the last one
                                        if (i < avl.length - 1) {
                                            await new Promise(r => setTimeout(r, 500));
                                        }
                                    }

                                    if (schData.errorMessage) {
                                        expandRow.innerHTML = `<td colspan="22" style="padding: 12px; color: #ff8a80; background: rgba(0,0,0,0.4);">❌ Schedule Error: ${schData.errorMessage}</td>`;
                                        return;
                                    }

                                    let fareBlocks = fareResults.map(fareData => {
                                        if (!fareData || fareData.error || !fareData.totalFare) return '';
                                        return `
                                        <div style="display:flex; flex-direction:column; min-width: 140px; background: rgba(255,255,255,0.05); padding: 8px 12px; border-radius: 6px; border: 1px dashed rgba(255,255,255,0.1);">
                                            <div style="font-weight:bold; font-size: 14px; margin-bottom: 4px; border-bottom: 1px solid rgba(255,255,255,0.1); padding-bottom: 4px;">
                                                Class ${fareData.enqClass}
                                            </div>
                                            <div style="display:flex; justify-content:space-between; font-size: 11px; color:#8892b0;">
                                                <span>Base</span> <strong>₹${fareData.baseFare || 0}</strong>
                                            </div>
                                            <div style="display:flex; justify-content:space-between; font-size: 11px; color:#8892b0;">
                                                <span>Res/SF</span> <strong>₹${(fareData.reservationCharge || 0) + (fareData.superfastCharge || 0)}</strong>
                                            </div>
                                            <div style="display:flex; justify-content:space-between; font-size: 11px; color:#8892b0;">
                                                <span>GST</span> <strong>₹${(fareData.goodsServiceTax || 0) + (fareData.otherCharge || 0)}</strong>
                                            </div>
                                            <div style="display:flex; justify-content:space-between; font-size: 13px; margin-top: 4px; padding-top: 4px; border-top: 1px solid rgba(255,255,255,0.1);">
                                                <span style="color:#69f0ae;">Total</span> <strong style="color:#69f0ae;">₹${fareData.totalFare}</strong>
                                            </div>
                                        </div>`;
                                    }).join('');

                                    let fareHTML = '';
                                    if (fareBlocks) {
                                        fareHTML = `
                                            <div style="display:flex; gap: 12px; margin-top: 12px; margin-bottom: 12px; overflow-x: auto; padding-bottom: 4px;">
                                                ${fareBlocks}
                                            </div>
                                        `;
                                    }

                                    let pathHTML = '<div style="display:flex; flex-direction:column; gap:4px; margin-top: 4px; font-size: 12px; color: rgba(255,255,255,0.8); max-height: 250px; overflow-y: auto;">';

                                    if (schData.stationList) {
                                        // Header
                                        pathHTML += `<div style="display:flex; font-weight:bold; color: #fff; padding-bottom: 4px; border-bottom: 1px solid rgba(255,255,255,0.1); padding-right: 8px;">
                                            <div style="width: 40px;">#</div>
                                            <div style="flex: 2;">Station</div>
                                            <div style="flex: 1;">Arr.</div>
                                            <div style="flex: 1;">Dep.</div>
                                            <div style="flex: 1;">Halt</div>
                                            <div style="flex: 1; text-align:right;">Dist.(km)</div>
                                        </div>`;

                                        schData.stationList.forEach(st => {
                                            const isSource = st.stationCode === fromStnCode;
                                            const isDest = st.stationCode === toStnCode;
                                            let bg = 'transparent';
                                            if (isSource) bg = 'rgba(105, 240, 174, 0.1)';
                                            else if (isDest) bg = 'rgba(255, 138, 128, 0.1)';

                                            pathHTML += `
                                            <div style="display:flex; padding: 4px 8px; background: ${bg}; border-radius: 4px;">
                                                <div style="width: 40px; opacity:0.6;">${st.stnSerialNumber}</div>
                                                <div style="flex: 2; font-weight: ${isSource || isDest ? 'bold' : 'normal'}; color: ${isSource ? '#69f0ae' : isDest ? '#ff8a80' : 'white'};">
                                                    ${st.stationName} (${st.stationCode})
                                                    ${isSource ? ' [Boarding]' : isDest ? ' [Dest]' : ''}
                                                </div>
                                                <div style="flex: 1;">${st.arrivalTime}</div>
                                                <div style="flex: 1;">${st.departureTime}</div>
                                                <div style="flex: 1; opacity:0.7;">${st.haltTime}</div>
                                                <div style="flex: 1; text-align:right;">${st.distance}</div>
                                            </div>`;
                                        });
                                    }
                                    pathHTML += '</div>';

                                    expandRow.innerHTML = `
                                    <td colspan="22" style="padding: 0; border: none; max-width: 0;">
                                        <div style="background: rgba(0, 0, 0, 0.6); border-top: 1px solid rgba(255,255,255,0.05); padding: 12px 16px; box-sizing: border-box; width: 100%;">
                                            <div style="display:flex; justify-content:space-between; align-items:flex-start;">
                                                <div style="display:flex; flex-direction:column; width: 100%;">
                                                    <div style="font-weight: 600; color: #a1c4fd; font-size: 14px;">
                                                        🕒 Route Schedule & Fare: ${trainNumber} - ${trainName}
                                                    </div>
                                                    ${fareHTML}
                                                </div>
                                                <button style="background:none; border:none; color:white; font-size: 16px; cursor:pointer;" onclick="this.closest('tr').remove();">✕</button>
                                            </div>
                                            ${pathHTML}
                                        </div>
                                    </td>`;

                                } catch (err) {
                                    expandRow.innerHTML = `<td colspan="22" style="padding: 12px; color: #ff8a80; background: rgba(0,0,0,0.4);">❌ Request Failed: ${err.message}</td>`;
                                }
                            });
                        }

                        tbody.appendChild(tr);
                    } catch (e) {
                        console.error("[eRail API] Error formatting train row:", e, t);
                    }
                });

                statusMsg.style.display = 'none';
                container.style.display = 'block';

            } catch (err) {
                console.error(err);
                statusMsg.innerText = "Error fetching trains: " + err.message;
            }
        });
    }

    const pnrBtn = document.getElementById('erail-pnr-btn');
    if (pnrBtn) {
        pnrBtn.addEventListener('click', async () => {
            let pnrText = document.getElementById('erail-pnr').value.trim();
            if (!pnrText || pnrText.length !== 10) return alert("Please enter a valid 10-digit PNR.");

            const statusMsg = document.getElementById('erail-loading-status');
            const tbody = document.getElementById('erail-table-body');
            const thead = document.getElementById('erail-table-head');
            const container = document.getElementById('erail-results-container');

            statusMsg.style.display = 'block';
            statusMsg.innerText = "Solving Captcha & Fetching PNR...";
            container.style.display = 'none';
            tbody.innerHTML = '';

            try {
                const data = await window.erailCheckPNR(pnrText);

                if (data.errorMessage) {
                    statusMsg.innerText = "Error: " + data.errorMessage;
                    return;
                }

                if (!data.passengerList || data.passengerList.length === 0) {
                    statusMsg.innerText = "PNR successfully fetched but contains no passenger details.";
                    return;
                }

                thead.innerHTML = `
                    <tr>
                        <th class="text-left" colspan="2" style="font-size: 15px;">🚆 ${data.trainNumber} - ${data.trainName}</th>
                        <th colspan="3" style="color: #69f0ae;">PNR: ${data.pnrNumber}</th>
                        <th colspan="3" style="color: #a1c4fd;">Journey: ${data.dateOfJourney}</th>
                    </tr>
                    <tr>
                        <th class="text-left">Passenger</th>
                        <th>Booking Status</th>
                        <th>Booking Coach/Berth</th>
                        <th>Current Status</th>
                        <th>Current Coach/Berth</th>
                        <th>Class / Quota</th>
                        <th>Chart Status</th>
                        <th>Boarding - Dest</th>
                    </tr>
                `;

                data.passengerList.forEach((p, idx) => {
                    const tr = document.createElement('tr');

                    let cStatusWord = p.currentStatus;
                    let cColor = "white";
                    if (cStatusWord.includes("CNF")) cColor = "#69f0ae";
                    else if (cStatusWord.includes("WL")) cColor = "#ff8a80";
                    else if (cStatusWord.includes("RAC")) cColor = "#ffd740";

                    tr.innerHTML = `
                        <td class="text-left" style="font-weight: bold;">Passenger ${idx + 1}</td>
                        <td style="opacity: 0.7;">${p.bookingStatusDetails}</td>
                        <td style="opacity: 0.7;">${p.bookingCoachId || "N/A"}/${p.bookingBerthNo || 0}/${p.bookingBerthCode || ""}</td>
                        <td style="color: ${cColor}; font-weight: bold; font-size: 14px;">${p.currentStatus}</td>
                        <td style="color: ${cColor};">${p.currentCoachId || "N/A"}/${p.currentBerthNo || 0}/${p.currentBerthCode || ""}</td>
                        <td style="color: #fffb7a;">${data.journeyClass} / ${p.passengerQuota}</td>
                        <td style="color: #ffb74d;">${data.chartStatus}</td>
                        <td>${data.boardingPoint} &rarr; ${data.destinationStation}</td>
                    `;
                    tbody.appendChild(tr);
                });

                statusMsg.style.display = 'none';
                container.style.display = 'block';

            } catch (err) {
                console.error(err);
                statusMsg.innerText = "Error fetching PNR: " + err.message;
            }
        });
    }

    document.getElementById('swap-btn').addEventListener('click', () => {
        const src = document.getElementById('erail-src');
        const dst = document.getElementById('erail-dst');
        const tmp = src.value;
        src.value = dst.value;
        dst.value = tmp;
    });

    const shiftDate = (days) => {
        let currentStr = document.getElementById('erail-date').value;
        if (!currentStr) return;
        let d = new Date(currentStr);
        d.setDate(d.getDate() + days);
        const mm = String(d.getMonth() + 1).padStart(2, '0');
        const dd = String(d.getDate()).padStart(2, '0');
        const yyyy = d.getFullYear();
        document.getElementById('erail-date').value = `${yyyy}-${mm}-${dd}`;
    };

    document.getElementById('prev-day').addEventListener('click', () => shiftDate(-1));
    document.getElementById('next-day').addEventListener('click', () => shiftDate(1));

    document.getElementById('erail-table-head').addEventListener('click', async (e) => {
        if (!e.target.classList.contains('class-header')) return;

        const th = e.target;
        const cls = th.getAttribute('data-cls');
        if (!cls) return;

        if (th.classList.contains('processing')) return;
        th.classList.add('processing');
        th.style.opacity = '0.5';

        try {
            const cells = document.querySelectorAll(`.class-cell[data-cls="${cls}"]`);
            for (let i = 0; i < cells.length; i++) {
                const cell = cells[i];
                if (!cell.classList.contains('loading') && !cell.classList.contains('empty') && cell.innerText === 'Check') {
                    if (cell._fetchData) {
                        await cell._fetchData();
                        // Adding a 500ms delay between fetches to stagger requests and avoid API blocks
                        await new Promise(r => setTimeout(r, 500));
                    } else {
                        cell.click();
                    }
                }
            }
        } finally {
            th.classList.remove('processing');
            th.style.opacity = '1';
        }
    });

    document.getElementById('erail-reset-btn').addEventListener('click', () => {
        // Hide table and show generic status
        document.getElementById('erail-table-body').innerHTML = '';
        document.getElementById('erail-results-container').style.display = 'none';

        const statusMsg = document.getElementById('erail-loading-status');
        statusMsg.style.display = 'block';
        statusMsg.innerText = "Ready to search...";
    });
}

// Inject the beautiful UI 
if (document.readyState === 'complete' || document.readyState === 'interactive') {
    injectAppUI();
} else {
    document.addEventListener('DOMContentLoaded', injectAppUI);
}

console.log("✅ [eRail Custom API Ready]");
console.log("👉 Use: await window.erailSearchTrain('NDLS', 'BCT', '28-02-2026')");
console.log("👉 Use: await window.erailFetchCalendar('12904', 'SL', '28-02-2026', 'NDLS', 'BCT')");
