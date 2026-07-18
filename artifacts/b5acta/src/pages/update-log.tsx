import { Newspaper } from "lucide-react";
import { Layout } from "@/components/layout";

const UPDATE_LOG = [
  {
    date: "July 18, 2026",
    title: "Public Alpha Board Guidance And Combat Clarity",
    tag: "public-alpha",
    items: [
      "Battle Log now records Anti-Fighter results and keeps combat logs visible after completed games.",
      "End Phase fighter launching now guides players from the launch prompt, to eligible carrier highlights, to manual placement within the launch ring.",
      "Ship status can now show split hull and crew bars, or a compact text mode from Settings.",
      "AI controls were simplified to a single AI Play or AI Pause button.",
      "Attack targeting previews, PC right-click move confirmation, and clearer deployment wording were added.",
    ],
  },
  {
    date: "July 17, 2026",
    title: "Public Alpha Support Tools",
    tag: "testing",
    items: [
      "Added in-game bug rescue reporting for blocked steps, including opponent notification.",
      "Added a collapsible opponent chat panel for active games.",
      "Added FAQ and credits pages for public testers.",
      "Improved weapon identity checks to reduce ship weapon drift issues as variants are added.",
      "Updated public branding to Babylon 5: Wheel of Fire.",
    ],
  },
];

export default function UpdateLog() {
  return (
    <Layout title="Update Log">
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-5 p-4 md:p-6">
        <section className="border-b border-border pb-4">
          <div className="flex items-center gap-3">
            <Newspaper className="h-5 w-5 text-primary" />
            <div>
              <h2 className="text-sm font-bold uppercase tracking-[0.22em] text-primary">Public Alpha Updates</h2>
              <p className="mt-1 text-sm text-muted-foreground">
                Player-facing changes and fixes from recent builds.
              </p>
            </div>
          </div>
        </section>

        <div className="grid gap-4">
          {UPDATE_LOG.map(entry => (
            <article key={`${entry.date}-${entry.title}`} className="rounded border border-border bg-card/65 p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <div className="font-mono text-[11px] uppercase tracking-[0.2em] text-muted-foreground">{entry.date}</div>
                  <h3 className="mt-1 text-sm font-bold uppercase tracking-[0.18em] text-primary">{entry.title}</h3>
                </div>
                <span className="rounded border border-primary/35 bg-primary/10 px-2 py-1 font-mono text-[10px] uppercase tracking-[0.18em] text-primary">
                  {entry.tag}
                </span>
              </div>
              <ul className="mt-4 list-disc space-y-2 pl-5 text-sm leading-6 text-muted-foreground">
                {entry.items.map(item => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </article>
          ))}
        </div>
      </div>
    </Layout>
  );
}
