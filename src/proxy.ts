import { NextResponse, type NextRequest } from "next/server";

/**
 * Optimistic redirect only: sends visitors without a session cookie to /login.
 * This is NOT authorization — every page, action and route handler re-checks
 * the session and permissions on the server (src/server/auth/session.ts).
 */
const PUBLIC_PATHS = ["/login", "/api/health"];

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  // "/" is the public presentation page (no tenant data).
  if (pathname === "/" || PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`))) {
    return NextResponse.next();
  }
  if (!request.cookies.has("praetor_session")) {
    if (pathname.startsWith("/api/")) return NextResponse.json({ error: "Não autenticado." }, { status: 401 });
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    url.search = "";
    // The login page validates `next` with safeNextPath before using it.
    if (request.method === "GET" && pathname !== "/") url.searchParams.set("next", pathname + request.nextUrl.search);
    return NextResponse.redirect(url);
  }
  return NextResponse.next();
}

export const config = {
  // Upload routes are excluded so the proxy never buffers/truncates request bodies.
  matcher: ["/((?!_next/static|_next/image|favicon.ico|icon.svg|api/documents/upload).*)"],
};
