/** A fresh observation is required. Only use when the driver proves that no
 * input was dispatched; uncertain failures must still stop the run. */
export class JevStaleTargetError extends Error {}
