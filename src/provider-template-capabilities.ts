import { getTemplateById, type ProviderTemplate } from './provider-templates.js';

export function resolveTemplateCapabilities(identity?: { templateId?: string; providerId?: string }): ProviderTemplate | undefined {
  return (identity?.templateId ? getTemplateById(identity.templateId) : undefined)
    ?? (identity?.providerId ? getTemplateById(identity.providerId) : undefined);
}
