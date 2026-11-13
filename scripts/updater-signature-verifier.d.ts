export function normalizeUpdaterSignature(signaturePath: string): string;

export function decodeUpdaterSignatureEnvelope(signature: string): string;

export function verifyUpdaterSignaturePayload(options: {
  root: string;
  payload: Buffer;
  signature: string;
  runner?: (...args: unknown[]) => { status?: number | null; error?: Error };
  tempRoot?: string;
  env?: NodeJS.ProcessEnv;
}): boolean;

export function verifyUpdaterSignatures(options: {
  root: string;
  releaseDir: string;
  byName: Map<string, string>;
  signatureByBaseName: Map<string, string>;
  resolveUpdaterTargets(name: string): unknown[];
  runner?: (...args: unknown[]) => { status?: number; error?: Error };
}): boolean;
