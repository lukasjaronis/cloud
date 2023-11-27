import { NextResponse } from "next/server";
import { withGate } from "../utils/withGate";

export const POST = withGate(async (req: Request) => {
  console.log(req.headers.get('authorization'))
  return new NextResponse('👍 authorized')
});