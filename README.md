# Indian Rail eTicket Utility Extension

A powerful, native Chrome Extension built to seamlessly enhance the `indianrail.gov.in` interface. It injects a highly dynamic dark-mode React-style Javascript UI directly over existing web layers to quickly display train availability metrics, detailed multi-day schedules, and PNR ticket status using internal automated Captcha bypassing limits.

## 🚀 Key Features
* **No Manual Captchas**: Automates complex Captcha resolving instantly in the background dynamically using the lightweight `tesseract.js` web-worker embedded locally.
* **Intelligent Advanced Route Explorer (New!)**: Bypasses full trains by programmatically exploiting "Hidden Quota Availability". If `B → C` is waitlisted, the extension leverages a **Topological Binary Search Algorithm** forwards and backwards across the train's master schedule to pinpoint the *exact, cheapest physically confirmed node* on a longer ticket block (e.g. `Intermediate Station → Dest`), and advises the user to safely book it and simply change their "Boarding Point" later!
* **Smart LocalStorage Hydration**: Remembers your previously queried 'From', 'To', and precisely entered Dates effortlessly using secure local storage caching.
* **Bulk Class Verification**: Instantly iterate and fetch an entire column of seat classes sequentially at the press of a single Table Header (`1A`, `SL`, `3A`...) with staggered API limits to intelligently avoid rate limits.
* **Dynamic Journey Paths**: Click right on the numeric Train code from any Table result to seamlessly expand its absolute path list and platform schedule times in real-time.
* **Simultaneous Fare Calculation**: Dynamically fetches exact ticket fares for all active classes side-by-side (Base, Reservation, Superfast, GST, Total) directly above the route schedule securely.
* **10-Digit PNR Integration**: Bypasses slow legacy portal loads for precise PNR Passenger-by-Passenger current status and journey classification dynamically injected right above your UI dashboard.

## 📦 Local Installation (Unpacked)

Since this interacts dynamically with strict web-worker CSP bypasses locally, install it organically into Chrome via the generic developer extension menus. 

1. On your machine, launch Chrome and immediately navigate to `chrome://extensions`.
2. Activate the **Developer mode** toggle securely located on the top far right edge of the nav bar.
3. Choose the **"Load unpacked"** selection securely located firmly on the far top-left edge. 
4. Select the strict local path of this exact absolute directory. 
5. Navigate directly back to [indianrail.gov.in/enquiry](https://www.indianrail.gov.in/enquiry) to instantly load the freshly injected UI!

--- 
### Architecture 
Because standard HTTP `fetch()` requests directly invoke CSP barriers on the host structure, a hybrid local service is spun down using a transparent background script proxy:

`inject.js` constructs the local DOM matrix inside the page while aggressively piping `erailSolveCaptcha` parameters upstream to `content.js` > `background.js` where the `tesseract-core.wasm` worker silently slices the binary payload for raw text outputs. 

To ensure extreme continuity, `inject.js` manages its own internal exponential 3-factor auto-retry mechanism natively. It implements intelligent staggered promise delays between consecutive `/FARE` and `/CALENDAR` requests to ensure optimal fetching stability.
