import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

type GateVerifyReturnType = {
  method: string
  data: {
    isValid: boolean
  } | null
  error: string | null
}

type RequestHandler = (req: NextRequest) => Promise<NextResponse>;

export const withGate = (handler: RequestHandler): RequestHandler => {
  return async (req: NextRequest): Promise<NextResponse> => {
    const authHeader = req.headers.get('authorization');
    
    if (authHeader && authHeader.startsWith('Bearer ')) {
      const key = authHeader.replace('Bearer ', '')

      const response = await fetch('http://0.0.0.0:8787/api/keys/verify', {
        method: 'POST',
        headers: {
          "Authorization": "Bearer 66Sd6bz3LSqOgU8BOqPPXFshJAD5nZnVZfhWV55DxHE=",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ key })
      })

      const json = await response.json() as GateVerifyReturnType
      
      if (json.data && !json.data.isValid) {
        return new NextResponse('unauthorized', { status: 401 })
      }
    } else {
      return new NextResponse('unauthorized', { status: 401 })
    }

    return handler(req);
  };
};