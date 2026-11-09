// An AbortSignal that fires when the HTTP client goes away before the response was fully
// written (closed tab, front-end timeout...). `res.on('close')` is the right hook on
// Node 22: `req.aborted` is deprecated and `req.on('close')` also fires once the request
// body has been read, which is not a disconnection.
export const abortSignalForResponse = (res) => {
    const controller = new AbortController();
    res.once('close', () => {
        if (!res.writableFinished) {
            controller.abort(new Error('Request aborted by the client'));
        }
    });
    return controller.signal;
};
