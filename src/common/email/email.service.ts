
import {
  Injectable,
  Logger,
  InternalServerErrorException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';

@Injectable()
export class EmailService {
  private readonly logger = new Logger(EmailService.name);
  private readonly transporter: Transporter;

  constructor(private readonly configService: ConfigService) {
    const host = this.configService.getOrThrow<string>('SMTP_HOST');
    const port = this.configService.get<number>('SMTP_PORT', 465);
    const secure = this.configService.get<boolean>('SMTP_SECURE', true);
    const user = this.configService.getOrThrow<string>('SMTP_USER');
    const password =
      this.configService.getOrThrow<string>('SMTP_PASSWORD');

    this.transporter = nodemailer.createTransport({
      host,
      port,
      secure,
      auth: {
        user,
        pass: password,
      },
      connectionTimeout: 15000,
      greetingTimeout: 15000,
      socketTimeout: 20000,
    });
  }

  async verifyConnection(): Promise<boolean> {
    try {
      await this.transporter.verify();
      this.logger.log('SMTP connection verified successfully.');
      return true;
    } catch (error) {
      this.logger.error(
        'SMTP connection verification failed.',
        error instanceof Error ? error.stack : undefined,
      );
      throw new InternalServerErrorException(
        'Email service is currently unavailable.',
      );
    }
  }

  async sendEmail(
    to: string,
    subject: string,
    html: string,
    text?: string,
  ): Promise<void> {
    const fromName =
      this.configService.get<string>(
        'SMTP_FROM_NAME',
        'Slash Infotech CRM',
      );

    const fromEmail =
      this.configService.getOrThrow<string>('SMTP_FROM_EMAIL');

    try {
      await this.transporter.sendMail({
        from: {
          name: fromName,
          address: fromEmail,
        },
        to,
        subject,
        html,
        text,
      });

      this.logger.log(`Email successfully sent to ${to}`);
    } catch (error) {
      this.logger.error(
        'Email delivery failed.',
        error instanceof Error ? error.stack : undefined,
      );

      throw new InternalServerErrorException(
        'Unable to send email. Please try again later.',
      );
    }
  }
}
