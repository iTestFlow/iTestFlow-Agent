import type { ComponentType } from "react";

import type { LoadingGameName, MiniGameProps } from "./game-utils";
import {
  LOADING_GAME_DEFINITIONS,
  modifierFor,
  type LoadingGameMetadata,
} from "./game-definitions";
import { LightsOutGame } from "./LightsOutGame";
import { MemoryMatchGame } from "./MemoryMatchGame";
import { OddTileGame } from "./OddTileGame";
import { PatternSequenceGame } from "./PatternSequenceGame";
import { PipeConnectGame } from "./PipeConnectGame";
import { SnakeTrailGame } from "./SnakeTrailGame";
import { ZipPathGame } from "./ZipPathGame";

export type LoadingGameDefinition = LoadingGameMetadata & {
  component: ComponentType<MiniGameProps>;
};

const GAME_COMPONENTS: Record<LoadingGameName, ComponentType<MiniGameProps>> = {
  zip: ZipPathGame,
  pipe: PipeConnectGame,
  memory: MemoryMatchGame,
  lights: LightsOutGame,
  odd: OddTileGame,
  sequence: PatternSequenceGame,
  snake: SnakeTrailGame,
};

export const LOADING_GAME_CATALOG = Object.fromEntries(
  Object.entries(LOADING_GAME_DEFINITIONS).map(([name, metadata]) => [
    name,
    { ...metadata, component: GAME_COMPONENTS[name as LoadingGameName] },
  ]),
) as Record<LoadingGameName, LoadingGameDefinition>;

export { modifierFor };
