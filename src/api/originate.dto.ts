import { ApiProperty } from '@nestjs/swagger';
import { IsString, Matches } from 'class-validator';

export class OriginateDto {
  @ApiProperty({ description: 'Extension of the agent whose phone rings first', example: '1001' })
  @IsString()
  @Matches(/^\d{3,6}$/, { message: 'agentExt must be a 3-6 digit extension' })
  agentExt: string;

  @ApiProperty({ description: 'Destination number, dialed once the agent answers', example: '+966501234567' })
  @IsString()
  @Matches(/^\+?\d{3,15}$/, { message: 'number must be digits with optional leading +' })
  number: string;
}
