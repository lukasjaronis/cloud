import { NextResponse } from "next/server";
import { withGate } from "../utils/withGate";

export const POST = withGate(async (req: Request) => {
  return new NextResponse('👍 authorized')
});