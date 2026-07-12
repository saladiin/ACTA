import { CircleHelp } from "lucide-react";
import { Layout } from "@/components/layout";

const FAQ_SECTIONS = [
  {
    title: "Getting Started",
    items: [
      {
        q: "What is this game?",
        a: "An online version of Babylon 5: A Call to Arms where commanders maneuver fleets, line up arcs, fire weapons, and try to cripple or destroy the opposing force. The app handles most measuring, dice, damage tracking, and turn bookkeeping.",
      },
      {
        q: "Do I need to know the tabletop rules first?",
        a: "It helps, but you can learn by playing. Ships move and turn before firing, weapons need range and arc, initiative controls tempo, and the app blocks many illegal actions.",
      },
      {
        q: "What should I do first?",
        a: "Sign in, create or edit a fleet, start a new engagement from the lobby, pick an opponent or AI opponent, deploy your ships, then play through initiative, movement, firing, and end phase.",
      },
    ],
  },
  {
    title: "Fleets And Games",
    items: [
      {
        q: "How do I make a fleet?",
        a: "Open Fleets, create a named fleet, then add ships from the available ship list. Each ship becomes a unit you can deploy in a game.",
      },
      {
        q: "Do I need a perfect fleet list?",
        a: "No. For public testing, build something fun that helps test different ship sizes, weapon types, factions, and edge cases.",
      },
      {
        q: "How do I start a game?",
        a: "Open New Engagement, choose the setup, select a fleet if desired, and create the game. Depending on setup, another player may need to join and deploy before the engagement begins.",
      },
      {
        q: "Can I play against the AI?",
        a: "Yes, when AI opponent is enabled. AI games are useful for quick testing, but the AI is a convenience opponent, not a tournament-grade commander.",
      },
    ],
  },
  {
    title: "Board Basics",
    items: [
      {
        q: "What does the board represent?",
        a: "The board is measured in inches. One 3D world unit represents one inch, so movement and weapon ranges map directly onto the table.",
      },
      {
        q: "How do I select a ship?",
        a: "Click a ship or its base. The selected ship is highlighted and its available controls appear in the board controls or side panel.",
      },
      {
        q: "What do the colored rings and arcs mean?",
        a: "The base and arc overlays show orientation, weapon coverage, selected status, and current phase availability. Weapon arcs rotate with ship heading.",
      },
      {
        q: "Can I pre-measure?",
        a: "Yes. The app is designed around visible ranges, arcs, and board positioning so players can make informed moves.",
      },
    ],
  },
  {
    title: "Turn And Phase Flow",
    items: [
      {
        q: "What happens in a round?",
        a: "A normal round flows through Initiative, Movement, Firing, and End Phase. The app advances when both players have completed the required actions.",
      },
      {
        q: "What is initiative?",
        a: "Initiative determines who controls the pace of the round. After initiative, players alternate activations through movement and firing.",
      },
      {
        q: "Why can only some ships act?",
        a: "A ship may already have moved or fired, may be destroyed, may be affected by damage or criticals, or may not be eligible in the current phase.",
      },
      {
        q: "What if I have no useful action?",
        a: "Use the available pass or end controls. The app may allow passing when you have no eligible ships or are done acting in that phase.",
      },
    ],
  },
  {
    title: "Deployment And Movement",
    items: [
      {
        q: "How do I deploy ships?",
        a: "During deployment, place your ships inside your deployment zone. Once both sides are deployed, the game can begin.",
      },
      {
        q: "What is deployment depth?",
        a: "Deployment depth controls how far onto the board each player may place ships at the start. It is selected when the game is created.",
      },
      {
        q: "How does movement work?",
        a: "Activate an eligible ship, choose how far it moves, set any allowed turn, then confirm the move. The app tracks committed movement.",
      },
      {
        q: "Do ships have to move?",
        a: "Usually, yes. Most ships must move at least half their current speed unless a special action or damage state allows otherwise.",
      },
      {
        q: "What is All Stop?",
        a: "All Stop is a special movement choice that lets a ship remain stationary when allowed. Variants such as All Stop and Pivot affect rotation.",
      },
      {
        q: "What happens to adrift ships?",
        a: "Adrift ships cannot maneuver normally. The app handles compulsory drift timing and movement according to the current rules implementation.",
      },
    ],
  },
  {
    title: "Firing",
    items: [
      {
        q: "How do I attack?",
        a: "In Firing, activate a ship, select a weapon, choose an enemy target in range and arc, commit the shot, then follow the dice modal.",
      },
      {
        q: "Can one ship fire more than one weapon?",
        a: "Usually yes. A ship can fire multiple weapon systems during its firing activation, but each weapon can only be used once per activation.",
      },
      {
        q: "Why can I not target a ship?",
        a: "Common reasons include range, arc, friendly target, a weapon already fired, an inert or destroyed firing ship, or it not being your activation.",
      },
      {
        q: "What is a boresight weapon?",
        a: "A boresight weapon fires in a narrow forward or aft line and requires careful positioning.",
      },
      {
        q: "What are Energy Mines?",
        a: "Energy Mines are area-style weapons. In the app, the mine projectile travels to the target and creates a detonation pulse.",
      },
    ],
  },
  {
    title: "Dice And Damage",
    items: [
      {
        q: "Who rolls the dice?",
        a: "The app rolls dice for attacks, damage, criticals, and automated checks. The dice modal shows the sequence so players can follow what happened.",
      },
      {
        q: "What does to hit mean?",
        a: "Attack dice must meet or beat the target number. Some weapon traits, such as Beam or Mini-Beam, use special hit behavior.",
      },
      {
        q: "What happens after a hit?",
        a: "The app resolves defenses, then rolls damage results. Hits may cause hull damage, crew loss, critical effects, or no meaningful damage.",
      },
      {
        q: "What are critical hits?",
        a: "Critical hits represent serious system damage to engines, reactor, weapons, crew, or vital systems. Some can be repaired later; some are permanent.",
      },
      {
        q: "Why did a hit do no damage?",
        a: "Possible reasons include bulkhead results, shields, interceptors, dodge, GEG, defensive traits, or special weapon handling.",
      },
    ],
  },
  {
    title: "End Phase And Special Actions",
    items: [
      {
        q: "What happens in End Phase?",
        a: "End Phase handles cleanup and end-of-round effects such as damage control, delayed explosions, adrift drift, shield and interceptor refresh, and round advancement.",
      },
      {
        q: "What is Damage Control?",
        a: "Damage Control attempts to repair some ongoing critical effects. It does not simply restore all lost hull or crew.",
      },
      {
        q: "What are special actions?",
        a: "Special actions trade normal flexibility for specific benefits, such as All Stop, All Stop and Pivot, or Concentrate All Fire-power.",
      },
      {
        q: "Why can I not use a special action?",
        a: "The ship may be crippled, skeleton-crewed, affected by a critical, at the wrong timing, already committed to movement or firing, or using an action not yet implemented.",
      },
      {
        q: "What is Concentrate All Fire-power?",
        a: "It is a special action focused on improving fire against a nominated target. The app marks the nominated target relationship visually when active.",
      },
    ],
  },
  {
    title: "Fighters, AI, And Testing",
    items: [
      {
        q: "Are fighters different from capital ships?",
        a: "Yes. Fighter units have different activation and base-overlap behavior and are handled separately for some phase and targeting rules.",
      },
      {
        q: "Can fighters overlap ships?",
        a: "The app allows fighter and capital bases to overlap in situations where two capital ships would not be allowed to share the same space.",
      },
      {
        q: "How do AI turns work?",
        a: "AI actions are advanced by AI step controls or automatic step controls depending on the current build. The AI uses server-side rules checks like a human player.",
      },
      {
        q: "Should I report strange AI behavior?",
        a: "Yes. Include the game, round, phase, active ship, and what the AI did.",
      },
      {
        q: "What does public alpha mean?",
        a: "The game is playable enough for testing, but balance, rules fidelity, UI polish, and edge cases are still being improved.",
      },
      {
        q: "What should I include in bug reports?",
        a: "Include the game URL or ID, round and phase, ship names, weapon used if any, what you expected, what happened, and a screenshot or browser error if available.",
      },
    ],
  },
];

export default function Faq() {
  return (
    <Layout title="FAQ">
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-5 p-4 md:p-6">
        <section className="border-b border-border pb-4">
          <div className="flex items-center gap-3">
            <CircleHelp className="h-5 w-5 text-primary" />
            <div>
              <h2 className="text-sm font-bold uppercase tracking-[0.22em] text-primary">Player FAQ</h2>
              <p className="mt-1 text-sm text-muted-foreground">
                Quick answers for public alpha testers learning the online board.
              </p>
            </div>
          </div>
        </section>

        <div className="grid gap-4">
          {FAQ_SECTIONS.map(section => (
            <section key={section.title} className="rounded border border-border bg-card/65 p-4">
              <h3 className="text-xs font-bold uppercase tracking-[0.22em] text-primary">{section.title}</h3>
              <div className="mt-4 divide-y divide-border/70">
                {section.items.map(item => (
                  <article key={item.q} className="py-3 first:pt-0 last:pb-0">
                    <h4 className="text-sm font-semibold text-foreground">{item.q}</h4>
                    <p className="mt-1 text-sm leading-6 text-muted-foreground">{item.a}</p>
                  </article>
                ))}
              </div>
            </section>
          ))}
        </div>
      </div>
    </Layout>
  );
}
