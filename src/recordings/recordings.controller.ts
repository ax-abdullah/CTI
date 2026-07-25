import { Controller, Get, NotFoundException, Param, Res } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiProduces, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { RecordingsService } from './recordings.service';

@ApiTags('Recordings')
@Controller('v1/recordings')
export class RecordingsController {
  constructor(private readonly recordings: RecordingsService) {}

  /** Auth is the signed short-lived token itself (capability URL). */
  @ApiOperation({
    summary: 'Fetch a call recording via its signed capability URL',
    description:
      'The token (from call.ended recordingUrl) embeds the file and a 15-minute expiry; ' +
      'no other credential is needed, and expired or tampered tokens return 404.',
  })
  @ApiParam({ name: 'token', description: 'Signed token from a call.ended recordingUrl' })
  @ApiProduces('audio/wav')
  @Get(':token')
  async fetch(@Param('token') token: string, @Res() res: Response) {
    const opened = await this.recordings.open(token);
    if (!opened) throw new NotFoundException('Invalid or expired recording link');
    res.setHeader('Content-Type', 'audio/wav');
    res.setHeader('Content-Disposition', `inline; filename="${opened.file}"`);
    opened.stream.pipe(res);
  }
}
