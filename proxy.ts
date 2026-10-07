import { NextResponse, type NextRequest } from "next/server"

import {
  cameThroughRelay,
  guardsWorkflowRoutes,
} from "@/lib/security/workflow-guard"

/**
 * Workflow deliveries come from this process's own runner (#179).
 *
 * Outside Vercel, `/.well-known/workflow/**` answers only requests that came
 * through the relay instrumentation.ts started, and tells anything else the
 * route does not exist. See lib/security/workflow-guard.ts for why "came from
 * localhost" is not enough.
 *
 * Matched to those routes alone, so no other request pays for a proxy.
 */
export function proxy(request: NextRequest): NextResponse {
  if (guardsWorkflowRoutes() && !cameThroughRelay(request.headers)) {
    return new NextResponse("Not found", {
      status: 404,
      headers: { "cache-control": "no-store" },
    })
  }
  return NextResponse.next()
}

export const config = {
  matcher: ["/.well-known/workflow/:path*"],
}
