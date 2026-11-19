export function timeVirtual(view, name, fn) {
    let start = performance.now();
    try {
        return fn();
    }
    finally {
        recordVirtual(view, name, performance.now() - start);
    }
}

export function recordVirtual(view, name, duration) {
    let state = view && view._virtualization;
    if (!state)
        return;
    let perf = state.perf || (state.perf = {});
    let sample = perf[name] || (perf[name] = { count: 0, total: 0, max: 0 });
    sample.count++;
    sample.total += duration;
    sample.max = Math.max(sample.max, duration);
}
