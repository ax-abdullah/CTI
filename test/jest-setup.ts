import { Logger } from '@nestjs/common';

// Keep test output focused on assertions, not the app's runtime logs.
Logger.overrideLogger(false);
