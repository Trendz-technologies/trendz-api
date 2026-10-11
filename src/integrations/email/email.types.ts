export interface EmailAttachment {
  filename: string;
  content: Buffer;
  contentType: string;
}

export interface EmailMessage {
  to: string;
  subject: string;
  html: string;
  text: string;
  attachments?: EmailAttachment[];
}

export interface EmailProvider {
  readonly name: string;
  send(message: EmailMessage): Promise<{ messageId: string | null }>;
}
