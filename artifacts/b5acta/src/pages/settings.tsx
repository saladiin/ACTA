import { Gamepad2, Palette, PanelLeft, PanelRight, Rotate3D, ZoomIn } from "lucide-react";
import { Layout } from "@/components/layout";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Label } from "@/components/ui/label";
import { useUiArcColorScheme, useUiControlMode, type UiArcColorScheme, type UiControlMode } from "@/hooks/use-ui-settings";

const CONTROL_MODES: Array<{
  id: UiControlMode;
  name: string;
  summary: string;
  details: string[];
}> = [
  {
    id: "mode-a",
    name: "Mode A",
    summary: "Current controls",
    details: ["One-finger orbit", "Pinch zoom", "Two-finger drag pan"],
  },
  {
    id: "mode-b",
    name: "Mode B",
    summary: "Split touch controls",
    details: ["Left side orbit", "Right side pan", "Pinch anywhere zoom"],
  },
  {
    id: "mode-c",
    name: "Mode C",
    summary: "Map-first controls",
    details: ["One-finger pan", "Pinch zoom", "Two-finger drag pan"],
  },
  {
    id: "mode-d",
    name: "Mode D",
    summary: "Long-press orbit",
    details: ["One-finger pan", "Long-press then drag orbit", "Pinch zoom"],
  },
  {
    id: "mode-e",
    name: "Mode E",
    summary: "Two-finger orbit",
    details: ["One-finger pan", "Pinch zoom", "Two-finger drag orbit"],
  },
  {
    id: "mode-f",
    name: "Mode F",
    summary: "Top-down tactical",
    details: ["One-finger pan", "Pinch zoom", "Orbit locked out"],
  },
];

const ARC_COLOR_SCHEMES: Array<{
  id: UiArcColorScheme;
  name: string;
  summary: string;
  swatches: string[];
}> = [
  {
    id: "classic",
    name: "Classic",
    summary: "Current forward, side, aft, boresight, and turret colors.",
    swatches: ["#ffb000", "rgba(0, 255, 222, 1)", "#ff2f4f", "#fff75a", "#b86cff"],
  },
  {
    id: "side",
    name: "Side colors",
    summary: "Friendly arcs use green shades; enemy arcs use red shades.",
    swatches: ["#34eb52", "#00d46a", "#0f9f4a", "#b7ff7a", "#ff0004", "#ff4f57", "#a90012"],
  },
];

export default function Settings() {
  const [controlMode, setControlMode] = useUiControlMode();
  const [arcColorScheme, setArcColorScheme] = useUiArcColorScheme();

  return (
    <Layout title="Settings">
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-5 p-4 md:p-6">
        <section className="border-b border-border pb-4">
          <div className="flex items-center gap-3">
            <Gamepad2 className="h-5 w-5 text-primary" />
            <div>
              <h2 className="text-sm font-bold uppercase tracking-[0.22em] text-primary">UI Control Method</h2>
              <p className="mt-1 text-sm text-muted-foreground">Stored on this device.</p>
            </div>
          </div>
        </section>

        <RadioGroup
          value={controlMode}
          onValueChange={(value) => setControlMode(value as UiControlMode)}
          className="grid gap-3 md:grid-cols-2"
          data-testid="ui-control-mode-radio-group"
        >
          {CONTROL_MODES.map(mode => (
            <Label
              key={mode.id}
              htmlFor={`control-${mode.id}`}
              className={`block cursor-pointer rounded border p-4 transition-colors ${
                controlMode === mode.id
                  ? "border-primary bg-primary/10 text-foreground"
                  : "border-border bg-card/65 text-muted-foreground hover:border-primary/50 hover:bg-card"
              }`}
            >
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="flex items-center gap-2">
                    <RadioGroupItem id={`control-${mode.id}`} value={mode.id} />
                    <span className="font-mono text-sm font-bold uppercase tracking-widest">{mode.name}</span>
                  </div>
                  <p className="mt-2 text-base font-semibold text-foreground">{mode.summary}</p>
                </div>
                {mode.id === "mode-b" ? (
                  <div className="flex items-center gap-1 text-cyan-300">
                    <PanelLeft className="h-4 w-4" />
                    <PanelRight className="h-4 w-4" />
                  </div>
                ) : (
                  <Rotate3D className="h-5 w-5 text-primary" />
                )}
              </div>
              <div className="mt-4 grid gap-2 text-xs uppercase tracking-wider">
                {mode.details.map((detail, index) => (
                  <div key={detail} className="flex items-center gap-2">
                    {index === 2 ? <ZoomIn className="h-3.5 w-3.5 text-primary" /> : <span className="h-1.5 w-1.5 rounded-full bg-primary" />}
                    <span>{detail}</span>
                  </div>
                ))}
              </div>
            </Label>
          ))}
        </RadioGroup>

        <section className="mt-3 border-t border-border pt-5">
          <div className="flex items-center gap-3">
            <Palette className="h-5 w-5 text-primary" />
            <div>
              <h2 className="text-sm font-bold uppercase tracking-[0.22em] text-primary">Arc Colors</h2>
              <p className="mt-1 text-sm text-muted-foreground">Stored on this device.</p>
            </div>
          </div>
        </section>

        <RadioGroup
          value={arcColorScheme}
          onValueChange={(value) => setArcColorScheme(value as UiArcColorScheme)}
          className="grid gap-3 md:grid-cols-2"
          data-testid="ui-arc-color-scheme-radio-group"
        >
          {ARC_COLOR_SCHEMES.map(scheme => (
            <Label
              key={scheme.id}
              htmlFor={`arc-color-${scheme.id}`}
              className={`block cursor-pointer rounded border p-4 transition-colors ${
                arcColorScheme === scheme.id
                  ? "border-primary bg-primary/10 text-foreground"
                  : "border-border bg-card/65 text-muted-foreground hover:border-primary/50 hover:bg-card"
              }`}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="flex items-center gap-2">
                  <RadioGroupItem id={`arc-color-${scheme.id}`} value={scheme.id} />
                  <span className="font-mono text-sm font-bold uppercase tracking-widest">{scheme.name}</span>
                </div>
                <div className="flex items-center gap-1">
                  {scheme.swatches.map(color => (
                    <span
                      key={color}
                      className="h-4 w-4 rounded-sm border border-black/70"
                      style={{ background: color }}
                    />
                  ))}
                </div>
              </div>
              <p className="mt-3 text-sm text-muted-foreground">{scheme.summary}</p>
            </Label>
          ))}
        </RadioGroup>
      </div>
    </Layout>
  );
}
