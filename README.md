# Nginx Front-End Ingress Policy Router

A browser-based Distributed Systems demo that simulates an Nginx-style front-end ingress gateway for a Black Friday sales environment. The gateway applies traffic admission policies before requests reach the upstream checkout pool.

## What Was Implemented

- Token-bucket rate limiting with an 8-token capacity per client.
- Automatic token refill every 500ms.
- Internal subnet bypass for `10.0.0.0/24` traffic.
- Severe throttling for `192.168.1.5`, where each request costs 3 tokens.
- Dynamic blocking for the rogue subnet `203.0.113.0/24`.
- Sliding-window spike detection: more than 15 requests in 3 seconds raises a high-severity warning.
- Low-priority telemetry shedding when pressure increases.
- High-contrast denial and alert UI for rejected or suspicious requests.
- Live metrics for allowed, denied, shed, and alert counts.
- Gateway visualization showing client, ingress boundary, Nginx policy router, route, and upstream pool.
- Criteria Evidence tab summarizing the implemented evaluation points.

## Project Structure

```text
index.html          Main page
server.mjs          Local static server on port 5188
src/main.jsx        React UI and policy simulation logic
src/styles.css      Application styling
vendor/             Local React, ReactDOM, and Babel files
package.json        Run script
```

## Environment Requirements

Install Node.js first if it is not already installed.

Recommended:

- Node.js 18 or newer
- npm, included with Node.js

Check versions:

```powershell
node --version
npm.cmd --version
```

## Run Locally

After cloning the repository, open PowerShell inside the project folder and run:

```powershell
npm install
```

Start the local server:

```powershell
npm.cmd run dev
```

Open the app:

```text
http://127.0.0.1:5188
```

Alternative command:

```powershell
node server.mjs
```

Note: this project has no external npm dependencies, but `npm install` is included as a standard setup step for the instructor after cloning. The React, ReactDOM, and Babel browser files are included locally in the `vendor` folder.

## How To Demonstrate The Features

1. Open the `Live Sandbox` tab.
2. Select a traffic source from the left panel.
3. Select an upstream route such as `/checkout`, `/cart`, `/assets`, or `/telemetry`.
4. Click `Send Request` to process one request.
5. Click `Trigger Burst` to simulate a traffic spike.
6. Watch the token counters, decision panel, denial monitor, logs, and metrics update live.

## Suggested Evaluation Walkthrough

### Token Bucket Rate Limiting

1. Select `External Shopper`.
2. Select `/checkout`.
3. Click `Trigger Burst`.
4. Observe the token counter decreasing from 8 and denials appearing when the bucket is empty.

### Whitelisted Internal Subnet

1. Select `Internal Checkout Service`.
2. Click `Trigger Burst`.
3. Observe `200 Bypass Granted` and the token meter showing `BYPASS`.

### Severe Throttling

1. Select `Severely Throttled IP`.
2. Send multiple requests.
3. Observe that each request consumes 3 tokens, causing faster rate limiting.

### Dynamic Rogue Network Block

1. Select `Rogue Scraper Network`.
2. Keep `Block 203.0.113.0/24` enabled.
3. Click `Send Request`.
4. Observe `403 Dynamic Network Block` and denial logs.

### Sliding-Window Spike Detection

1. Select any non-blocked client.
2. Click `Trigger Burst`.
3. If more than 15 hits occur inside 3 seconds, observe the high-severity warning banner.

### Telemetry Shedding

1. Select a limited client.
2. Select `/telemetry`.
3. Trigger enough traffic to reduce available tokens.
4. Observe `Telemetry Shed`, which protects checkout throughput by dropping low-priority traffic first.

## Notes For The Instructor

The project is self-contained. After cloning, run `npm install`, then `npm.cmd run dev`, and open `http://127.0.0.1:5188`.
