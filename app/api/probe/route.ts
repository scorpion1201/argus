import { NextResponse } from 'next/server';
import { runDerpprobe } from '@/lib/derpprobe';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const result = await runDerpprobe();
  return NextResponse.json(result, {
    status: result.ok ? 200 : 503,
    headers: {
      'Cache-Control': 'no-store, max-age=0'
    }
  });
}
