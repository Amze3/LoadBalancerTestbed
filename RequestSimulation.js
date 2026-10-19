const requestIntervals = [
    500, 450, 400, 350, 300, 250, 200, 150, 100, 50,
    30, 20, 15, 10, 5, 1
];
const requestsPerInterval = 20;
const loadBalancerUrl = "http://127.0.0.1:8080";

const wait = milliseconds =>
    new Promise(resolve => setTimeout(resolve, milliseconds));

async function sendRequest(requestNumber) {
    try {
        const response = await fetch(
            `${loadBalancerUrl}/simulation-${requestNumber}`
        );
        const result = await response.text();
        return result.includes("Session ACCESS GRANTED");
    } catch (error) {
        console.error(`Request ${requestNumber} failed: ${error.message}`);
        return false;
    }
}

async function simulateRequests() {
    for (const interval of requestIntervals) {
        const requests = [];

        for (let i = 0; i < requestsPerInterval; i++) {
            requests.push(sendRequest(i + 1));
            if (i < requestsPerInterval - 1) {
                await wait(interval);
            }
        }

        const results = await Promise.all(requests);
        const successes = results.filter(Boolean).length;
        const failures = results.length - successes;

        console.log(
            `${interval} ms apart: ${successes}/${results.length} succeeded ` +
            `(${(successes / results.length * 100).toFixed(1)}%), ` +
            `${failures}/${results.length} failed ` +
            `(${(failures / results.length * 100).toFixed(1)}%)`
        );
    }
}

simulateRequests().catch(error => {
    console.error("Request simulation failed:", error);
    process.exitCode = 1;
});