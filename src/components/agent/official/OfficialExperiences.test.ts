import { describe, expect, test } from "bun:test";

describe("official experience styles", () => {
  test("leaves the transcript trailing gutter to the shared scroll surface", async () => {
    const officialCss = await Bun.file(`${import.meta.dir}/OfficialExperiences.css`).text();
    const providerCss = await Bun.file(`${import.meta.dir}/../provider/ProviderExperience.css`).text();

    expect(officialCss).not.toMatch(/\.official-transcript\s*\{[^}]*padding:\s*[^;]*\s(?:24|28)px;/s);
    expect(providerCss).not.toMatch(/\.cx-rail\s*\{[^}]*padding:\s*[^;]*\s28px;/s);
    expect(providerCss).not.toMatch(/\.oc-lanes\s*\{[^}]*padding:\s*[^;]*\s24px;/s);
  });

  test("keeps the animated workflow arrow visible at both travel extremes", async () => {
    const css = await Bun.file(`${import.meta.dir}/OfficialExperiences.css`).text();
    const runningMarker = css.match(
      /\.official-plan-steps li\.is-running \.official-plan-step-mark\s*\{([^}]*)\}/,
    );

    expect(runningMarker?.[1]).toContain("overflow: visible");
  });

  test("centers pending plan step numbers on their ink box, not the em-square", async () => {
    const css = await Bun.file(`${import.meta.dir}/OfficialExperiences.css`).text();
    const marker = css.match(/\.official-plan-step-mark\s*\{([^}]*)\}/);
    const number = css.match(/\.official-plan-step-number\s*\{([^}]*)\}/);

    expect(marker?.[1]).toContain("display: flex");
    expect(marker?.[1]).toContain("align-items: center");
    expect(marker?.[1]).toContain("justify-content: center");
    expect(number?.[1]).toContain("text-box: trim-both cap alphabetic");
    expect(number?.[1]).not.toContain("translateY");
  });
});
