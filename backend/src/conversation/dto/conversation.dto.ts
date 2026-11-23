import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsString,
  IsOptional,
  IsIn,
  IsMongoId,
  IsArray,
  ArrayMaxSize,
  MaxLength,
} from 'class-validator';
import { MAX_NAME_LENGTH, MAX_PARTICIPANTS } from '../../common/input.util';

export class CreateConversationDto {
  @ApiPropertyOptional({
    description: 'Conversation type: DM or GROUP. Defaults to DM for single participant, GROUP for multiple.',
    enum: ['DM', 'GROUP'],
    example: 'DM',
  })
  @IsOptional()
  @IsIn(['DM', 'GROUP'])
  type?: 'DM' | 'GROUP';

  @ApiPropertyOptional({
    description: 'Name of the conversation. Optional for DM, recommended for GROUP.',
    example: 'Project Alpha',
  })
  @IsOptional()
  @IsString()
  @MaxLength(MAX_NAME_LENGTH)
  name?: string;

  @ApiPropertyOptional({
    description: 'Array of participant user ObjectIds (caller is added automatically).',
    example: ['64b8f9e2c4a3b12d4e5f6790'],
    type: [String],
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_PARTICIPANTS)
  @IsMongoId({ each: true })
  participants_ids?: string[];

  @ApiPropertyOptional({ description: 'Legacy DM recipient ObjectId; caller is added automatically.' })
  @IsOptional()
  @IsMongoId()
  recipient_id?: string;
}

export class ConversationIdParamDto {
  @IsMongoId()
  id: string;
}


export class ConversationResponseDto {
  @ApiProperty({
    description: 'Unique MongoDB ObjectId of the conversation',
    example: '64b8f9e2c4a3b12d4e5f0001',
  })
  id: string;

  @ApiPropertyOptional({
    description: 'Name of the conversation ([DM] {username} for DMs, custom name for Groups)',
    example: '[DM] Alice',
  })
  name?: string;

  @ApiProperty({
    description: 'Type of conversation: DM (direct message) or GROUP',
    example: 'DM',
    enum: ['DM', 'GROUP'],
  })
  type: string;

  @ApiProperty({
    description: 'ISO timestamp when the conversation was created',
    example: '2024-01-15T10:30:00.000Z',
  })
  createdAt: Date;

  @ApiProperty({
    description: 'MongoDB ObjectId of the user who created this conversation',
    example: '64b8f9e2c4a3b12d4e5f6789',
  })
  createdBy: string;

  @ApiProperty({
    description: 'List of participant user ObjectIds (including creator)',
    example: ['64b8f9e2c4a3b12d4e5f6789', '64b8f9e2c4a3b12d4e5f6790'],
    type: [String],
  })
  participants_ids: string[];

  @ApiPropertyOptional({ description: 'Most recent message time, or null for an empty conversation', nullable: true })
  lastMessageAt?: Date | null;

  @ApiPropertyOptional({ description: 'Bounded text/attachment preview, never binary data', nullable: true })
  lastMessagePreview?: string | null;

  @ApiPropertyOptional({ description: 'Messages not yet read by the authenticated caller', example: 0 })
  unreadCount?: number;
}
