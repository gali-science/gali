import { rewrite } from "@vercel/functions";
import { get } from "@vercel/global-config";

export const config = {
  matcher: "/((?!api/|assets/|about/assets/|fonts/|favicon\\.svg|maintenance\\.html).*)",
};

export default async function middleware(request: Request) {
  try {
    if (await get<boolean>("maintenanceMode")) {
      return rewrite(new URL("/maintenance.html", request.url));
    }
  } catch {
    console.error("[gali] maintenance flag unavailable");
  }
}
