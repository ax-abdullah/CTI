import { IsString, Matches } from 'class-validator';

export class OriginateDto {
  /** Extension of the agent whose phone rings first. */
  @IsString()
  @Matches(/^\d{3,6}$/, { message: 'agentExt must be a 3-6 digit extension' })
  agentExt: string;

  /** Destination number, dialed once the agent answers. */
  @IsString()
  @Matches(/^\+?\d{3,15}$/, { message: 'number must be digits with optional leading +' })
  number: string;
}
