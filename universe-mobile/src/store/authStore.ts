import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import * as SecureStore from "expo-secure-store";
import type { StateStorage } from "zustand/middleware";

const secureStorage: StateStorage = {
  getItem: async (name) => (await SecureStore.getItemAsync(name)) ?? null,
  setItem: async (name, value) => {
    await SecureStore.setItemAsync(name, value);
  },
  removeItem: async (name) => {
    await SecureStore.deleteItemAsync(name);
  },
};

interface AuthState {
  userId: string;
  userName: string;
  displayName: string;
  hydrated: boolean;
  setUser: (id: string, name: string, displayName: string) => void;
  clear: () => void;
  _setHydrated: (v: boolean) => void;
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set) => ({
      userId: "",
      userName: "",
      displayName: "",
      hydrated: false,
      setUser: (id, name, displayName) =>
        set({ userId: id, userName: name, displayName }),
      clear: () => set({ userId: "", userName: "", displayName: "" }),
      _setHydrated: (v) => set({ hydrated: v }),
    }),
    {
      name: "universe-auth",
      storage: createJSONStorage(() => secureStorage),
      partialize: (s) => ({
        userId: s.userId,
        userName: s.userName,
        displayName: s.displayName,
      }),
      onRehydrateStorage: () => (state) => {
        state?._setHydrated(true);
      },
    }
  )
);

export const getAuthHeaders = () => {
  const { userId, userName } = useAuthStore.getState();
  return {
    "x-user-id": userId,
    "x-user-name": userName,
  };
};

export const isLoggedIn = () => {
  const { userId } = useAuthStore.getState();
  return userId.length > 0;
};
