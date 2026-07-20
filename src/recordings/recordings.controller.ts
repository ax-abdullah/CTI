import { Controller, Get, NotFoundException, Param, Res } from '@nestjs/common';
import type { Response } from 'express';
import { RecordingsService } from './recordings.service';

@Controller('v1/recordings')
export class RecordingsController {
  constructor(private readonly recordings: RecordingsService) {}

  /** Auth is the signed short-lived token itself (capability URL). */
  @Get(':token')
  fetch(@Param('token') token: string, @Res() res: Response) {
    const opened = this.recordings.open(token);
    if (!opened) throw new NotFoundException('Invalid or expired recording link');
    res.setHeader('Content-Type', 'audio/wav');
    res.setHeader('Content-Disposition', `inline; filename="${opened.file}"`);
    opened.stream.pipe(res);
  }
}
