import type { LoadingGameName } from "./game-utils";

export type GameModifierDefinition = {
  id: string;
  label: string;
  description: string;
};

export type LoadingGameMetadata = {
  title: string;
  instructions: string;
  variantCount: number;
  modifiers: GameModifierDefinition[];
};

export const LOADING_GAME_NAMES: LoadingGameName[] = [
  "zip",
  "pipe",
  "memory",
  "lights",
  "odd",
  "sequence",
  "snake",
];

export const LOADING_GAME_DEFINITIONS: Record<LoadingGameName, LoadingGameMetadata> = {
  zip: {
    title: "Zip Path",
    instructions: "Draw one continuous route through every tile on a challenging 6×6 board.",
    variantCount: 8,
    modifiers: [
      { id: "compact", label: "Quick Grid", description: "A compact 4×4 route for a faster round." },
      { id: "extended", label: "Extra Stops", description: "The route includes six checkpoints." },
      { id: "reverse", label: "Reverse Route", description: "Start at the highest checkpoint and count down." },
      { id: "guided", label: "Guided Next", description: "The next checkpoint is subtly highlighted." },
      { id: "corner", label: "Corner Shift", description: "A transformed route begins and ends in opposite corners." },
    ],
  },
  pipe: {
    title: "Pipe Connect",
    instructions: "Rotate every pipe into one connected network.",
    variantCount: 8,
    modifiers: [
      { id: "expanded", label: "Expanded Grid", description: "Connect a larger 5×5 pipe network." },
      { id: "locked", label: "Locked Anchors", description: "Two correctly placed tiles cannot be rotated." },
      { id: "counter", label: "Reverse Turn", description: "Tiles rotate counterclockwise." },
      { id: "leaks", label: "Leak Check", description: "Open or mismatched pipe ends are highlighted." },
      { id: "sparse", label: "Sparse Network", description: "Solve a lighter loop with more straight pipes." },
    ],
  },
  memory: {
    title: "Memory Match",
    instructions: "Reveal cards and match every pair of symbols.",
    variantCount: 8,
    modifiers: [
      { id: "four-pairs", label: "Quick Four", description: "Match four pairs on a compact board." },
      { id: "six-pairs", label: "Classic Six", description: "Match six pairs at a comfortable pace." },
      { id: "eight-pairs", label: "Full Board", description: "Match eight pairs on a 4×4 board." },
      { id: "preview", label: "Preview First", description: "Study the visible cards, then hide them to begin." },
      { id: "peek", label: "One Peek", description: "Use one brief peek at any time." },
    ],
  },
  lights: {
    title: "Lights Out",
    instructions: "Press tiles until every light is off.",
    variantCount: 8,
    modifiers: [
      { id: "small", label: "Quick 3×3", description: "A small board for a short round." },
      { id: "standard", label: "Classic 4×4", description: "Pressing a light also toggles its direct neighbors." },
      { id: "large", label: "Expanded 5×5", description: "A larger board with the classic toggle rule." },
      { id: "diagonal", label: "Diagonal Switch", description: "Presses toggle diagonal neighbors instead." },
      { id: "wrap", label: "Wrapped Edges", description: "Edge presses also affect the opposite edge." },
    ],
  },
  odd: {
    title: "Find the Odd Tile",
    instructions: "Find the one symbol that differs from the rest.",
    variantCount: 8,
    modifiers: [
      { id: "orientation", label: "Orientation", description: "One symbol faces a different direction." },
      { id: "count", label: "Mark Count", description: "One symbol contains a different number of marks." },
      { id: "fill", label: "Fill Pattern", description: "One symbol uses a different fill treatment." },
      { id: "size", label: "Size Shift", description: "One symbol is subtly smaller." },
      { id: "offset", label: "Position Shift", description: "One symbol sits slightly off center." },
    ],
  },
  sequence: {
    title: "Pattern Sequence",
    instructions: "Watch the highlighted tiles, then repeat the pattern.",
    variantCount: 8,
    modifiers: [
      { id: "quick", label: "Quick Pattern", description: "Recall four steps on a 2×2 grid." },
      { id: "long", label: "Long Pattern", description: "Recall a longer six-step sequence." },
      { id: "spatial", label: "Spatial Grid", description: "Recall five steps across a 3×3 grid." },
      { id: "reverse", label: "Reverse Recall", description: "Enter the pattern in reverse order." },
      { id: "growing", label: "Growing Pattern", description: "Complete three rounds that grow from three to five steps." },
    ],
  },
  snake: {
    title: "Snake Trail",
    instructions: "Guide the trail one tile at a time and collect every target.",
    variantCount: 8,
    modifiers: [
      { id: "compact", label: "Compact Trail", description: "Collect five targets on a compact 6×6 grid." },
      { id: "wrap", label: "Wrapped Walls", description: "Leaving one edge continues from the opposite edge." },
      { id: "obstacles", label: "Obstacle Course", description: "Navigate around a few fixed blocked tiles." },
      { id: "ordered", label: "Ordered Targets", description: "Collect the numbered targets in order." },
      { id: "long", label: "Long Trail", description: "Collect eight targets as the trail grows." },
    ],
  },
};

export function modifierFor(game: LoadingGameName, modifierId: string | null): GameModifierDefinition | null {
  return LOADING_GAME_DEFINITIONS[game].modifiers.find((modifier) => modifier.id === modifierId) ?? null;
}
