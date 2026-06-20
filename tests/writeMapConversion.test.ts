import { describe, it, expect } from "vitest";
import { writeMapConversion } from "../src/geo/writeMapConversion";
import type { GeorefInfo } from "../src/ifc/editor";

const dec = (b: Uint8Array) => new TextDecoder("latin1").decode(b);
const G: GeorefInfo = { crsName: "EPSG:3844", eastings: 465711.25, northings: 407013.5, height: 12.5, rotationDeg: 30, scale: 1 };

describe("writeMapConversion", () => {
  it("updates an existing IfcMapConversion's numeric args", () => {
    const ifc = [
      "ISO-10303-21;",
      "DATA;",
      "#10=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-05,#11,$);",
      "#12=IFCPROJECTEDCRS('EPSG:3844',$,$,$,$,$,$);",
      "#13=IFCMAPCONVERSION(#10,#12,0.,0.,0.,1.,0.,1.);",
      "ENDSEC;",
      "END-ISO-10303-21;",
      "",
    ].join("\n");
    const { bytes, mode } = writeMapConversion(new TextEncoder().encode(ifc), G, "IFC4");
    const out = dec(bytes);
    expect(mode).toBe("updated");
    expect(out).toMatch(/IFCMAPCONVERSION\(#10,#12,465711\.25,407013\.5,12\.5,/);
    // cos30 ≈ 0.866, sin30 = 0.5, scale 1
    expect(out).toMatch(/,0\.86602540\d*,0\.5,1\.0?\);/);
    // only one conversion remains (no accidental duplication)
    expect(out.match(/IFCMAPCONVERSION/g)?.length).toBe(1);
  });

  it("injects IfcMapConversion (reusing the projected CRS) when none exists", () => {
    const ifc = [
      "ISO-10303-21;",
      "DATA;",
      "#10=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-05,#11,$);",
      "#12=IFCPROJECTEDCRS('EPSG:3844',$,$,$,$,$,$);",
      "ENDSEC;",
      "END-ISO-10303-21;",
      "",
    ].join("\n");
    const { bytes, mode } = writeMapConversion(new TextEncoder().encode(ifc), G, "IFC4");
    const out = dec(bytes);
    expect(mode).toBe("injected");
    // new conversion references the Model context #10 and the existing CRS #12
    expect(out).toMatch(/=IFCMAPCONVERSION\(#10,#12,465711\.25,407013\.5,/);
    // inserted before the section terminator
    expect(out.indexOf("IFCMAPCONVERSION")).toBeLessThan(out.indexOf("ENDSEC"));
  });

  it("injects both a projected CRS and a conversion when neither exists", () => {
    const ifc = [
      "ISO-10303-21;",
      "DATA;",
      "#10=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-05,#11,$);",
      "ENDSEC;",
      "END-ISO-10303-21;",
      "",
    ].join("\n");
    const { bytes, mode } = writeMapConversion(new TextEncoder().encode(ifc), G, "IFC4X3");
    const out = dec(bytes);
    expect(mode).toBe("injected");
    expect(out).toMatch(/=IFCPROJECTEDCRS\('EPSG:3844'/);
    expect(out).toMatch(/=IFCMAPCONVERSION\(#10,#1[1-9]/);
  });

  it("leaves IFC2x3 untouched", () => {
    const ifc = "ISO-10303-21;\nDATA;\nENDSEC;\nEND-ISO-10303-21;\n";
    const { bytes, mode } = writeMapConversion(new TextEncoder().encode(ifc), G, "IFC2X3");
    expect(mode).toBe("unsupported");
    expect(dec(bytes)).toBe(ifc);
  });
});
