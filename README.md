# rougarou

An indoor bouldering game set in the rougarou rock lounge. Walk the gym, pick a problem by its grade, pull on at its start holds, then move each hand and foot yourself, shift your weight, and try to send it. Physics and your own strength are the only limits.

**Play in the browser:** https://beerooyay.github.io/rougarou/ (desktop and phone)

## How to play

- **The menu** (M, Esc or the round button) lists every problem with your sends, best time and flashes, and lets you climb one straight away, walk to it, or set it. Settings change your shirt, shorts and shoe colors, sound, look speed and graphics.
- **Clips:** press the red dot (or the backtick key) to record the game with its sound. Clips stay in your browser, and the viewer trims, splits and downloads them.
- **Route setting:** pick "set it" on a problem, then drag holds across the wall, turn them (Q and E, the arrows or the mouse wheel), change their type, add or remove holds. A turned hold is pulled a different way, so the climbing changes too. Your sets are saved in the browser and can be reset.

- **Walking the gym:** WASD to walk (Shift to jog), drag to look around. On a phone the left thumb walks and the right thumb looks. Each problem has a tag with its grade. Walk up to one and click or tap its two start holds (or press E, or the pull on button) to pull on. `[` and `]` take you to the previous or next problem.
- **Climbing on desktop:** click a hand or foot, move the mouse to reach, then click to place it on whatever it touches. To shift your hips, use WASD or drag on empty wall. Esc puts the limb back, X lets it hang, J jumps down to the mats, R retries, and G shows the whole gym.
- **First person:** press V while climbing to see through your own eyes. The mouse looks around (click to capture it), a dot marks the middle of the screen, and the hold under it glows. Press R or L for the side, then A for the arm or L for the leg: R A is the right hand, L A the left hand, R L the right foot, L L the left foot. The keys go one after another, not together. Your arms, legs and body are drawn, and elbows and knees stay out of the wall. The arrow keys shift your hips and latch: press one once and the shift holds until you press it again, and Space centers you, so W, A, S and D are free. In this view your body hangs further off the wall and your knees splay, so you can see your legs when you look down. Retry is the button here, since R starts a limb pick.
- **AI climber:** Settings, "ai climber", adds a second climber who tours the gym, then climbs from the easiest problem up and moves on to the next hardest after each send. Press B (or the button) to watch it. It asks OpenAI for each move through the local server, so start the game with `OPENAI_API_KEY=sk-... python3 tools/devserver.py` (the key stays on your machine and is never sent to the browser). With no key it still climbs, by rehearsing moves on a copy of its body. "hard: learns from falls" turns the rehearsal off, so it has to work balance out for itself and learn from its notebook, which is kept in `tools/.cache/ai-memory.json`.
- **The AI as the gym's route setter:** set "how it plays" to "sets routes". Tuck (the AI has a name and a personality now) picks a problem nobody is climbing, designs new holds for it (OpenAI with a key, his own generator without), and a solver climbs the design before he touches the wall: a hold no body can reach, a start that cannot hold, or a grade far from the one asked for gets it rejected and redone. Then he does the work with his hands: walks to the wall, stands a ladder against it for anything above his reach, climbs it rung by rung (three points of contact), takes each hold off and puts it where it goes, and climbs the new problem to prove it. If he cannot send it, he fixes it or puts it back. His sets are kept in your browser like your own.
- **Climbing on a phone:** drag a hand or foot onto a hold. To shift your hips, drag on empty wall.

A problem is sent when both hands are matched on the top hold and held under control. Come off and you fall onto the mats, then get back up and can walk back to the start.

## What the climbing models

- **Three points of contact.** The limbs on the wall share your weight according to their strength. Legs are far stronger than arms, and a smear carries only a fraction.
- **Hold types.** Jugs, crimps, slopers, pinches and pockets each hold differently, depending on which way you pull them.
- **Steep walls peel you off.** Slabs press your feet in instead.
- **Reaching shifts your hips and turns your torso.** This is what makes cross moves possible.
- **Hands and feet travel at human speed.** A limb only takes weight once it arrives.
- **Deadpoints.** A hold caught while your body is still locks right in. One caught mid-swing has to be fought for.
- **Forearm pump.** Bent-arm lock-offs pump you far faster than hanging off straight arms.
- **Gradual slipping.** A brief overload is held, a sustained one creeps off, and a big one rips straight off.
- **Bare wall is friction only.** A palm or a smear can be pushed against but never pulled on. It grips only as hard as something presses the body into the wall: a slab leaning you onto it, or hands on good holds pulling your hips in. Overhangs pull you off and take that squeeze away.
- **Limb weight and flagging.** Each leg is about a sixth of your mass and hangs where you put it, so a free leg turns the body. Flag it across to the side of your holds to stop a barn door.
- **You need a hand on.** Feet alone only hold you on a low-angle slab. Anywhere steeper you tip back off.

## Layout

- `unreal/` is the main build, in Unreal 5.8 with a C++ module. `ClimbSim.*` is the climbing model and the source of truth.
- `web/` is the browser port (three.js, no build step). It is deployed to GitHub Pages by `.github/workflows/pages.yml`. `node web/check.mjs` proves every problem can be sent.
- `unity/` and `godot/` are the original prototypes.
