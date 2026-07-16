import { ScrollText } from "lucide-react";
import { Layout } from "@/components/layout";

const PEOPLE = [
  "Badhaircut55",
  "Dave Hribar",
  "Fabio Passaro",
  "Conor Clancy",
  "I_E_Mavericks",
  "Amras-Arfeiniel",
  "BadQueenCreations",
  "Premier Valle / Premier Valleweb",
  "Tyrellohr",
];

export default function Credits() {
  return (
    <Layout title="Credits">
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-5 p-4 md:p-6">
        <section className="border-b border-border pb-4">
          <div className="flex items-center gap-3">
            <ScrollText className="h-5 w-5 text-primary" />
            <div>
              <h2 className="text-sm font-bold uppercase tracking-[0.22em] text-primary">Asset Attribution</h2>
              <p className="mt-1 text-sm text-muted-foreground">
                Babylon 5 ship and visual assets are used with attribution for a non-commercial fan project.
              </p>
            </div>
          </div>
        </section>

        <section className="rounded border border-border bg-card/65 p-4">
          <h3 className="text-xs font-bold uppercase tracking-[0.22em] text-primary">Creators</h3>
          <ul className="mt-4 space-y-2 text-sm text-muted-foreground">
            {PEOPLE.map(person => (
              <li key={person} className="flex gap-2">
                <span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-primary" />
                <span>{person}</span>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </Layout>
  );
}
