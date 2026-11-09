import { useEffect, useState } from "react";

export function usePhoneShell() {
  const [phone, setPhone] = useState(() =>
    typeof window.matchMedia === "function"
      && window.matchMedia("(max-width: 768px)").matches,
  );

  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const media = window.matchMedia("(max-width: 768px)");
    const onChange = () => setPhone(media.matches);
    onChange();
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, []);

  return phone;
}
