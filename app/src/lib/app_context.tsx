import { createContext, useContext, type Accessor, type JSX } from "solid-js";
import type { Awareness } from "y-protocols/awareness";
import type { AgentReviewStore } from "./agent_review";
import type { CollabPermission, CollabStatus } from "./collab_provider";
import type { LocalFolderSync } from "./local_folder_sync";

export type AppCollabContext = {
  status: Accessor<CollabStatus>;
  permission: Accessor<CollabPermission | null>;
  peer_count: Accessor<number>;
  awareness: Accessor<Awareness | null>;
};

export type AppContextValue = {
  get_folder_sync: () => LocalFolderSync | null;
  collab: AppCollabContext;
  agent_review_store: AgentReviewStore;
};

const AppContext = createContext<AppContextValue>();

export function AppContextProvider(props: { value: AppContextValue; children: JSX.Element }) {
  return <AppContext.Provider value={props.value}>{props.children}</AppContext.Provider>;
}

export function use_app_context(): AppContextValue {
  const value = useContext(AppContext);
  if (!value) {
    throw new Error("use_app_context must be used within AppContextProvider");
  }
  return value;
}
