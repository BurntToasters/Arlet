import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const readScript = (name: string) =>
  fs.readFileSync(path.resolve(process.cwd(), "scripts", name), "utf8");

describe("Windows signing identity policy", () => {
  it("uses deterministic Artifact Signing tool discovery and overrides", () => {
    const tools = readScript("artifact-signing-tools.ps1");
    expect(tools).toContain("AZURE_ARTIFACT_SIGNING_SIGNTOOL_PATH");
    expect(tools).toContain("AZURE_ARTIFACT_SIGNING_DLIB_PATH");
    expect(tools).toContain("Import-BundledPowerShellSecurityModule");
    expect(tools).toContain("Azure.CodeSigning.Dlib.dll");
    expect(tools).toContain("Windows Kits\\10\\bin");
  });

  it("requires full publisher and timestamp proof before skipping or passing", () => {
    for (const script of [
      "windows-artifact-sign.ps1",
      "verify-windows-authenticode.ps1",
    ]) {
      const source = readScript(script);
      expect(source).toContain("AZURE_ARTIFACT_SIGNING_PUBLISHER_DN");
      expect(source).toContain("SignerCertificate.Subject.Trim()");
      expect(source).toContain("expectedSubject");
      expect(source).toContain("TimeStamperCertificate");
      expect(source).toContain("GetNameInfo");
    }
  });

  it("keeps verification scoped to Arlet runtime and NSIS outputs", () => {
    const verify = readScript("verify-windows-authenticode.ps1");
    expect(verify).toContain("bundle");
    expect(verify).toContain(".exe");
    expect(verify).toContain(".msi");
    expect(verify).not.toContain("Zinnia");
    expect(verify).not.toContain("ContextMenu");
    expect(verify).not.toContain(".msix");
  });

  it("validates the downloaded Microsoft installer before execution", () => {
    const setup = readScript("setup-windows-artifact-signing.ps1");
    expect(setup).toContain("Import-BundledPowerShellSecurityModule");
    expect(setup).toContain("Get-AuthenticodeSignature");
    expect(setup).toContain("Microsoft Corporation");
    expect(setup).toContain("ArtifactSigningClientTools.msi");
  });
});
