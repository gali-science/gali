import { SignInButton, useClerk } from "@clerk/react";
import { useEffect } from "react";
import { TryPage } from "../try/TryPage";

export function LoginScreen() {
  const clerk = useClerk();

  useEffect(() => {
    const url = new URL(window.location.href);
    if (!url.searchParams.has("waitlist")) return;
    url.searchParams.delete("waitlist");
    window.history.replaceState(window.history.state, "", url);
    clerk.openWaitlist();
  }, [clerk]);

  return (
    <TryPage
      signIn={(label, className) => (
        <SignInButton mode="modal">
          <button type="button" className={className}>{label}</button>
        </SignInButton>
      )}
      joinWaitlist={(label, className) => (
        <button type="button" className={className} onClick={() => clerk.openWaitlist()}>{label}</button>
      )}
    />
  );
}
