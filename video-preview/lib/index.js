/**
 * Host half of the media preview bundle.
 *
 * Nothing runs on the host: the sidebar preview is registered in the browser through the
 * `documentPreviews` service. This module exists so the Loader mounts the package and
 * `@deepseek-ai/dsh-client-modules` can find the `dsh.client` half in the manifest.
 */
export const name = 'video-preview'

/** @returns nothing; the browser half owns the behaviour. */
export function apply() {}
