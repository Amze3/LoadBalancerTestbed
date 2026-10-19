const port = Number(process.env.PORT) || 8080;
const baseUrl = `http://127.0.0.1:${port}`;
const legitimateCount = 12;
const legitimateIntervalMs = 500;
const abusiveBurstCount = 14;
const abusiveStartMs = 2000;
const oversizedCount = 8;

const results = {
    legitimate: { sent: 0, succeeded: 0, latencyMs: 0 },
    abusive: {
        sent: 0,
        rejected: 0,
        defenceRejected: 0,
        oversizedRejected: 0,
        rateLimited: 0,
        applicationDenied: 0,
        latencyMs: 0
    }
};

const wait = milliseconds =>
    new Promise(resolve => setTimeout(resolve, milliseconds));

async function sendRequest(type, number, oversized = false) {
    const startedAt = Date.now();
    let responseStatus = 0;
    let responseText = "";

    try {
        const response = await fetch(`${baseUrl}/abuse-test-${type}-${number}`, {
            method: type === "abusive" ? "POST" : "GET",
            headers: type === "abusive" ? { "Content-Type": "text/plain" } : {},
            body: type === "abusive" ? "x".repeat(oversized ? 2048 : 10) : undefined,
            signal: AbortSignal.timeout(5000)
        });
        responseStatus = response.status;
        responseText = await response.text();
    } catch (error) {
        responseText = error.message;
    }

    const elapsedMs = Date.now() - startedAt;
    if (type === "legitimate") {
        results.legitimate.sent++;
        if (responseText.includes("Session ACCESS GRANTED")) {
            results.legitimate.succeeded++;
        }
        results.legitimate.latencyMs += elapsedMs;
    } else {
        results.abusive.sent++;
        if (responseStatus === 413 || responseStatus === 429) {
            results.abusive.defenceRejected++;
            results.abusive.rejected++;
            if (responseStatus === 413) results.abusive.oversizedRejected++;
            if (responseStatus === 429) results.abusive.rateLimited++;
        } else if (!responseText.includes("Session ACCESS GRANTED")) {
            results.abusive.applicationDenied++;
            results.abusive.rejected++;
        }
        results.abusive.latencyMs += elapsedMs;
    }
}

async function run() {
    const statusResponse = await fetch(`${baseUrl}/__test/defences`);
    if (!statusResponse.ok) {
        throw new Error("Could not read defence settings; is the load balancer running?");
    }
    const settings = await statusResponse.json();
    console.log(`Abuse defences: ${settings.enabled ? "enabled" : "disabled"}`);
    console.log(
        `Mixed local workload: ${legitimateCount} legitimate requests at ` +
        `${legitimateIntervalMs} ms intervals, plus ${abusiveBurstCount} burst requests.`
    );
    console.log(
        `With defences: body limit ${settings.maxRequestBodyBytes} bytes; ` +
        `rate limit ${settings.maxRequestsPerWindow} requests per ${settings.rateLimitWindowMs} ms.`
    );

    const legitimateRequests = Array.from({ length: legitimateCount }, async (_, index) => {
        await wait(index * legitimateIntervalMs);
        await sendRequest("legitimate", index + 1);
    });
    const abusiveRequests = (async () => {
        await wait(abusiveStartMs);
        await Promise.all(Array.from({ length: abusiveBurstCount }, (_, index) =>
            sendRequest("abusive", index + 1, index < oversizedCount)
        ));
    })();

    await Promise.all([...legitimateRequests, abusiveRequests]);

    const legitimate = results.legitimate;
    const abusive = results.abusive;
    const legitimateRate = legitimate.sent
        ? (legitimate.succeeded / legitimate.sent * 100).toFixed(1)
        : "0.0";
    const abusiveRejectRate = abusive.sent
        ? (abusive.rejected / abusive.sent * 100).toFixed(1)
        : "0.0";
    console.log(
        `Legitimate served: ${legitimate.succeeded}/${legitimate.sent} ` +
        `(${legitimateRate}%), average latency ` +
        `${(legitimate.latencyMs / legitimate.sent).toFixed(1)} ms`
    );
    console.log(
        `Abusive rejected by defences: ${abusive.defenceRejected}/${abusive.sent} ` +
        `(${(abusive.defenceRejected / abusive.sent * 100).toFixed(1)}%): ` +
        `${abusive.oversizedRejected} oversized (413), ${abusive.rateLimited} rate-limited (429); ` +
        `${abusive.applicationDenied} additionally denied by server/datastore.`
    );
    console.log(
        `All abusive requests not served: ${abusive.rejected}/${abusive.sent} ` +
        `(${abusiveRejectRate}%), average latency ` +
        `${(abusive.latencyMs / abusive.sent).toFixed(1)} ms`
    );
}

run().catch(error => {
    console.error("Abuse traffic simulation failed:", error.message);
    process.exitCode = 1;
});
