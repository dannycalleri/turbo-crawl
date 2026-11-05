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

export type PageResponse = {
    /** Null when navigation produced no response, such as an `about:blank` or same-document URL. */
    status: number | null;
    xRobotsTag: string | null;
    tdmReservation: string | null;
    tdmPolicy: string | null;
    retryAfter: string | null;
};

export type PagePacket = {
    url: string;
    finalUrl: string;
    fetchedAt: string;
    title: string | null;
    response: PageResponse;

    metadata: PageMetadata;
    jsonLd: JsonLdBlock[];

    visibleBlocks: DomBlock[];
    links: LinkBlock[];
    images: ImageBlock[];
    tables: TableBlock[];

    stats: PagePacketStats;
};

