import { Gamepad2, Palette, PanelLeft, PanelRight, Rotate3D, Ship, SlidersHorizontal, ZoomIn } from "lucide-react";
import { Layout } from "@/components/layout";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { useUiArcColorScheme, useUiAttackPhasePulseOpacity, useUiAttackPhasePulseStrength, useUiBoardOpacity, useUiControlMode, useUiShipHullNames, useUiShipMeshTints, type UiArcColorScheme, type UiControlMode } from "@/hooks/use-ui-settings";

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
  const [shipMeshTintsEnabled, setShipMeshTintsEnabled] = useUiShipMeshTints();
  const [shipHullNamesEnabled, setShipHullNamesEnabled] = useUiShipHullNames();
  const [boardOpacity, setBoardOpacity] = useUiBoardOpacity();
  const [attackPulseOpacity, setAttackPulseOpacity] = useUiAttackPhasePulseOpacity();
  const [attackPulseStrength, setAttackPulseStrength] = useUiAttackPhasePulseStrength();

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

        <section className="mt-3 border-t border-border pt-5">
          <div className="flex items-center gap-3">
            <Ship className="h-5 w-5 text-primary" />
            <div>
              <h2 className="text-sm font-bold uppercase tracking-[0.22em] text-primary">Ship Mesh Colors</h2>
              <p className="mt-1 text-sm text-muted-foreground">Stored on this device.</p>
            </div>
          </div>
        </section>

        <div className="rounded border border-border bg-card/65 p-4">
          <div className="flex items-center justify-between gap-4">
            <div>
              <Label htmlFor="original-mesh-colors" className="font-mono text-sm font-bold uppercase tracking-widest">
                Original mesh colors only
              </Label>
              <p className="mt-2 text-sm text-muted-foreground">
                Removes friend/enemy tinting from ship meshes. Bases, halos, arcs, and UI status colors remain unchanged.
              </p>
            </div>
            <Switch
              id="original-mesh-colors"
              checked={!shipMeshTintsEnabled}
              onCheckedChange={(checked) => setShipMeshTintsEnabled(!checked)}
              data-testid="switch-original-mesh-colors"
            />
          </div>
          <div className="mt-4 border-t border-border pt-4">
            <div className="flex items-center justify-between gap-4">
              <div>
                <Label htmlFor="hide-ship-hull-names" className="font-mono text-sm font-bold uppercase tracking-widest">
                  Hide ship hull names
                </Label>
                <p className="mt-2 text-sm text-muted-foreground">
                  Removes floating ship names above hull meshes on the board. Health bars and tactical overlays remain visible.
                </p>
              </div>
              <Switch
                id="hide-ship-hull-names"
                checked={!shipHullNamesEnabled}
                onCheckedChange={(checked) => setShipHullNamesEnabled(!checked)}
                data-testid="switch-hide-ship-hull-names"
              />
            </div>
          </div>
        </div>

        <section className="mt-3 border-t border-border pt-5">
          <div className="flex items-center gap-3">
            <SlidersHorizontal className="h-5 w-5 text-primary" />
            <div>
              <h2 className="text-sm font-bold uppercase tracking-[0.22em] text-primary">Board Opacity</h2>
              <p className="mt-1 text-sm text-muted-foreground">Stored on this device.</p>
            </div>
          </div>
        </section>

        <div className="rounded border border-border bg-card/65 p-4">
          <div className="mb-4 flex items-center justify-between gap-4">
            <Label htmlFor="board-opacity" className="font-mono text-sm font-bold uppercase tracking-widest">
              Game board plane
            </Label>
            <span className="font-mono text-sm text-primary" data-testid="board-opacity-value">{boardOpacity}%</span>
          </div>
          <Slider
            id="board-opacity"
            min={0}
            max={100}
            step={5}
            value={[boardOpacity]}
            onValueChange={(value) => setBoardOpacity(value[0] ?? 100)}
            data-testid="slider-board-opacity"
          />
        </div>

        <section className="mt-3 border-t border-border pt-5">
          <div className="flex items-center gap-3">
            <SlidersHorizontal className="h-5 w-5 text-primary" />
            <div>
              <h2 className="text-sm font-bold uppercase tracking-[0.22em] text-primary">Attack Phase Pulse</h2>
              <p className="mt-1 text-sm text-muted-foreground">Stored on this device.</p>
            </div>
          </div>
        </section>

        <div className="rounded border border-border bg-card/65 p-4">
          <div className="mb-4 flex items-center justify-between gap-4">
            <Label htmlFor="attack-pulse-opacity" className="font-mono text-sm font-bold uppercase tracking-widest">
              Red overlay opacity
            </Label>
            <span className="font-mono text-sm text-primary" data-testid="attack-pulse-opacity-value">{attackPulseOpacity}%</span>
          </div>
          <Slider
            id="attack-pulse-opacity"
            min={0}
            max={100}
            step={5}
            value={[attackPulseOpacity]}
            onValueChange={(value) => setAttackPulseOpacity(value[0] ?? 18)}
            data-testid="slider-attack-pulse-opacity"
          />

          <div className="mb-4 mt-6 flex items-center justify-between gap-4">
            <Label htmlFor="attack-pulse-strength" className="font-mono text-sm font-bold uppercase tracking-widest">
              Emissive strength
            </Label>
            <span className="font-mono text-sm text-primary" data-testid="attack-pulse-strength-value">{attackPulseStrength}%</span>
          </div>
          <Slider
            id="attack-pulse-strength"
            min={0}
            max={100}
            step={5}
            value={[attackPulseStrength]}
            onValueChange={(value) => setAttackPulseStrength(value[0] ?? 35)}
            data-testid="slider-attack-pulse-strength"
          />
        </div>
      </div>
    </Layout>
  );
}
