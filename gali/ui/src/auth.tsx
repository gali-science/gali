import { ClerkProvider, useAuth, useClerk } from "@clerk/react";
import { createContext, type ReactNode, useContext } from "react";
import { configureAuthenticatedFetch } from "./auth-fetch";

type AuthState = {
  isLoaded: boolean;
  isSignedIn: boolean;
  signOut: (options?: { redirectUrl?: string }) => Promise<void>;
};

const AuthStateContext = createContext<AuthState | null>(null);
const localBypass = import.meta.env.VITE_GALI_DEV_AUTH_BYPASS === "1";

function ClerkAuthState({ children }: { children: ReactNode }) {
  const { getToken, isLoaded, isSignedIn } = useAuth();
  const { signOut } = useClerk();
  configureAuthenticatedFetch(() => getToken());
  return (
    <AuthStateContext.Provider
      value={{
        isLoaded,
        isSignedIn: Boolean(isSignedIn),
        signOut,
      }}
    >
      {children}
    </AuthStateContext.Provider>
  );
}

export function GaliAuthProvider({ children }: { children: ReactNode }) {
  if (localBypass) {
    configureAuthenticatedFetch(null, true);
    return (
      <AuthStateContext.Provider
        value={{
          isLoaded: true,
          isSignedIn: true,
          signOut: async () => {},
        }}
      >
        {children}
      </AuthStateContext.Provider>
    );
  }

  const publishableKey = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY;
  if (!publishableKey?.trim()) {
    throw new Error("VITE_CLERK_PUBLISHABLE_KEY is not set");
  }
  return (
    <ClerkProvider publishableKey={publishableKey} afterSignOutUrl="/">
      <ClerkAuthState>{children}</ClerkAuthState>
    </ClerkProvider>
  );
}

export function useGaliAuth(): AuthState {
  const auth = useContext(AuthStateContext);
  if (!auth) throw new Error("useGaliAuth must be used inside GaliAuthProvider");
  return auth;
}
