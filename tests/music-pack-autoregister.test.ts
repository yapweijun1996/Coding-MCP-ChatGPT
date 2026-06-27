import { test } from "node:test";
import assert from "node:assert/strict";
import { selectAutoRegistrablePacks } from "../src/mcp/tools/music-workflow.js";

// Shaped like discover_soundfont_packs' suggestedRegistration for the bundled GeneralUser-GS.
const GENERALUSER_REG = {
  packId: "generaluser-gs",
  displayName: "GeneralUser GS",
  instrumentRole: "realistic_piano",
  format: "soundfont",
  assetPaths: ["soundfonts/GeneralUser-GS.sf2"],
  declaredSha256: "a".repeat(64),
  licenseType: "generaluser_gs_2_0",
  source: "https://example.test/generaluser",
  sourceUrl: "https://example.test/generaluser",
  commercialUseAllowed: true,
  redistributionAllowed: true,
  productionUseApproved: true,
  qualityTier: "production_candidate"
};

test("selects a license-cleared production_candidate SoundFont", () => {
  const out = selectAutoRegistrablePacks([GENERALUSER_REG], {});
  assert.equal(out.length, 1);
  assert.equal(out[0].packId, "generaluser-gs");
});

test("rejects a review_required candidate (license not cleared)", () => {
  const review = { ...GENERALUSER_REG, qualityTier: "review_required", productionUseApproved: undefined, commercialUseAllowed: undefined };
  assert.equal(selectAutoRegistrablePacks([review], {}).length, 0);
});

test("rejects when production use is not approved or commercial use is not allowed", () => {
  assert.equal(selectAutoRegistrablePacks([{ ...GENERALUSER_REG, productionUseApproved: false }], {}).length, 0);
  assert.equal(selectAutoRegistrablePacks([{ ...GENERALUSER_REG, commercialUseAllowed: false }], {}).length, 0);
});

test("narrows to the requested packId and never registers a different instrument", () => {
  assert.equal(selectAutoRegistrablePacks([GENERALUSER_REG], { soundfontPackId: "generaluser-gs" }).length, 1);
  assert.equal(selectAutoRegistrablePacks([GENERALUSER_REG], { soundfontPackId: "some-other-pack" }).length, 0);
});

test("narrows to the requested soundfont asset path", () => {
  assert.equal(selectAutoRegistrablePacks([GENERALUSER_REG], { soundfontPath: "soundfonts/GeneralUser-GS.sf2" }).length, 1);
  assert.equal(selectAutoRegistrablePacks([GENERALUSER_REG], { soundfontPath: "soundfonts/other.sf2" }).length, 0);
});

test("skips undefined entries and schema-invalid payloads", () => {
  const invalid = { qualityTier: "production_candidate", productionUseApproved: true, commercialUseAllowed: true }; // missing required fields
  assert.equal(selectAutoRegistrablePacks([undefined, invalid], {}).length, 0);
});
