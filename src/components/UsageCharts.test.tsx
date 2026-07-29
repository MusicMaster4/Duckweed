import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { Meter } from "./UsageCharts";

function meterClass(percent: number): string {
  const html = renderToStaticMarkup(
    <Meter label="Quota" value={`${percent}%`} percent={percent} />,
  );
  return html.match(/class="viz-meter-track ([^"]+)"/)?.[1] ?? "";
}

describe("quota meter severity", () => {
  test("is red only below 10 percent remaining", () => {
    expect(meterClass(9)).toBe("is-critical");
    expect(meterClass(10)).toBe("is-warning");
  });

  test("is yellow below 35 percent remaining", () => {
    expect(meterClass(34)).toBe("is-warning");
    expect(meterClass(35)).toBe("is-ok");
  });
});
