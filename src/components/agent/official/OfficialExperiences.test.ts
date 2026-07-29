import { describe, expect, test } from "bun:test";

describe("official experience styles", () => {
  test("keeps the animated workflow arrow visible at both travel extremes", async () => {
    const css = await Bun.file(`${import.meta.dir}/OfficialExperiences.css`).text();
    const runningMarker = css.match(
      /\.official-plan-steps li\.is-running \.official-plan-step-mark\s*\{([^}]*)\}/,
    );

    expect(runningMarker?.[1]).toContain("overflow: visible");
  });
});
