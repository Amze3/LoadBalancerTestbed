const loadBalancerPort = Number(process.env.PORT) || 8080;
const loadBalancerUrl = `http://127.0.0.1:${loadBalancerPort}`;
const mode = process.argv[2];
const requestIntervalMs = 400;
const runDurationMs = 12000;
const failureAfterMs = 3000;
const failureDurationMs = 5000;

if (mode !== "baseline" && mode !== "fault") {
    console.error("Usage: node FaultToleranceSimulation.js baseline|fault");
    process.exit(1);
}

const phases = mode === "fault"
    ? ["Before failure", "Failure window", "After recovery"]
    : ["Baseline"];
const results = Object.fromEntries(phases.map(phase => [
    phase,
    { sent: 0, succeeded: 0, failed: 0, latencyMs: 0 }
]));
const pendingRequests = [];
let failureStartedAt;
let recoveryTimeMs;
let requestNumber = 0;

function getPhase(elapsedMs) {
    if (mode === "baseline") return "Baseline";
    if (elapsedMs < failureAfterMs) return "Before failure";
    if (elapsedMs < failureAfterMs + failureDurationMs) return "Failure window";
    return "After recovery";
}

async function sendRequest(phase, number) {
    const startedAt = Date.now();
    let succeeded = false;

    try {
        const response = await fetch(`${loadBalancerUrl}/fault-test-${number}`, {
            signal: AbortSignal.timeout(5000)
        });
        succeeded = (await response.text()).includes("Session ACCESS GRANTED");
    } catch (error) {
        console.error(`Request ${number} failed: ${error.message}`);
    }

    const result = results[phase];
    result.latencyMs += Date.now() - startedAt;
    result[succeeded ? "succeeded" : "failed"]++;
}

async function waitForRecovery() {
    let sawUnhealthy = false;
    const deadline = Date.now() + failureDurationMs + 10000;

    while (Date.now() < deadline) {
        const response = await fetch(`${loadBalancerUrl}/__test/status`, {
            signal: AbortSignal.timeout(2000)
        });
        if (!response.ok) {
            throw new Error(`Health status check failed: HTTP ${response.status}`);
        }
        const status = await response.json();
        const healthy = status.servers.S0 === true;
        if (!healthy) sawUnhealthy = true;
        if (sawUnhealthy && healthy) {
            recoveryTimeMs = Date.now() - failureStartedAt;
            return;
        }
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    console.error("Could not observe S0 recovering before the timeout.");
}

async function triggerFailure() {
    const response = await fetch(
        `${loadBalancerUrl}/__test/fail/S0?durationMs=${failureDurationMs}`
    );
    if (!response.ok) {
        throw new Error(`Failure simulation was rejected: ${await response.text()}`);
    }

    failureStartedAt = Date.now();
    console.log(`Simulated S0 outage for ${failureDurationMs} ms.`);
    return waitForRecovery();
}

async function run() {
    const statusResponse = await fetch(`${loadBalancerUrl}/__test/status`);
    if (!statusResponse.ok) {
        throw new Error("Could not read load-balancer health status.");
    }
    const status = await statusResponse.json();
    console.log(`Fault tolerance: ${status.faultToleranceEnabled ? "enabled" : "disabled"}`);
    console.log(`Workload: one request every ${requestIntervalMs} ms for ${runDurationMs / 1000} seconds.`);

    const startedAt = Date.now();
    let failureTask;
    const interval = setInterval(() => {
        const elapsedMs = Date.now() - startedAt;
        if (mode === "fault" && !failureTask && elapsedMs >= failureAfterMs) {
            failureTask = triggerFailure();
        }

        if (elapsedMs >= runDurationMs) {
            clearInterval(interval);
            return;
        }

        const phase = getPhase(elapsedMs);
        const number = ++requestNumber;
        results[phase].sent++;
        pendingRequests.push(sendRequest(phase, number));
    }, requestIntervalMs);

    await new Promise(resolve => setTimeout(resolve, runDurationMs + requestIntervalMs));
    await Promise.all(pendingRequests);
    if (failureTask) await failureTask;

    for (const phase of phases) {
        const result = results[phase];
        const successRate = result.sent
            ? (result.succeeded / result.sent * 100).toFixed(1)
            : "0.0";
        const averageLatency = result.sent
            ? (result.latencyMs / result.sent).toFixed(1)
            : "0.0";
        console.log(
            `${phase}: ${result.succeeded}/${result.sent} succeeded ` +
            `(${successRate}%), ${result.failed}/${result.sent} failed, ` +
            `average latency ${averageLatency} ms`
        );
    }

    const totalSucceeded = Object.values(results)
        .reduce((total, result) => total + result.succeeded, 0);
    const totalFailed = Object.values(results)
        .reduce((total, result) => total + result.failed, 0);
    console.log(`Total: ${requestNumber} sent, ${totalSucceeded} succeeded, ${totalFailed} failed.`);
    if (mode === "fault") {
        console.log(
            `Observed recovery time: ${recoveryTimeMs === undefined
                ? "not observed"
                : `${recoveryTimeMs} ms`}`
        );
    }
}

run().catch(error => {
    console.error("Fault-tolerance simulation failed:", error.message);
    process.exitCode = 1;
});
