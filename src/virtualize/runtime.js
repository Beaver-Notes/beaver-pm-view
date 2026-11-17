export const forkRuntime = Object.create(null);

export function configureForkRuntime(dependencies) {
    Object.assign(forkRuntime, dependencies);
}
