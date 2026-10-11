import type { PageMetadata } from "./extraction/metadata";
import type { JsonLdBlock } from "./extraction/jsonld";
import type { DomBlock } from "./extraction/dom";
import type { LinkBlock } from "./extraction/links";
import type { ImageBlock } from "./extraction/images";
import type { TableBlock } from "./extraction/tables";

export type PagePacketStats = {
    rawHtmlLength: number;
    bodyTextLength: number;
    visibleBlockCount: number;
    jsonLdCount: number;
    linkCount: number;
    imageCount: number;
    tableCount: number;
};

export type PagePacket = {
    url: string;
    finalUrl: string;
    fetchedAt: string;
    title: string | null;

    metadata: PageMetadata;
    jsonLd: JsonLdBlock[];

    visibleBlocks: DomBlock[];
    links: LinkBlock[];
    images: ImageBlock[];
    tables: TableBlock[];

    stats: PagePacketStats;
};

