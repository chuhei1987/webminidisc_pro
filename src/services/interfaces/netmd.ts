import {
    openNewDevice,
    NetMDInterface,
    Disc as NetMDDisc,
    listContent,
    openPairedDevice,
    Wireformat,
    MDTrack,
    getDeviceStatus,
    DeviceStatus,
    Group as NetMDGroup,
    renameDisc,
    DiscFormat,
    upload,
    rewriteDiscGroups,
    DiscFlag,
    MDSession,
    EKBOpenSource,
    NetMDFactoryInterface,
    readUTOCSector,
    writeUTOCSector,
    prepareDownload,
    getDescriptiveDeviceCode,
    cleanRead,
    MemoryType,
    formatQuery,
    scanQuery,
    unpatch,
    patch,
    Track as NetMDTrack,
    Encoding,
    TrackFlag,
    getRemainingCharactersForTitles,
    getCellsForTitle,
} from 'netmd-js';
import { makeGetAsyncPacketIteratorOnWorkerThread } from 'netmd-js/dist/web-encrypt-worker';
import { Logger } from 'netmd-js/dist/logger';
import { sanitizeHalfWidthTitle, sanitizeFullWidthTitle, concatUint8Arrays } from 'netmd-js/dist/utils';
import { asyncMutex, sleep, isSequential, recomputeGroupsAfterTrackMove, getPublicPathFor } from '../../utils';
import { Mutex } from 'async-mutex';
import {
    AtracRecovery,
    ExploitStateManager,
    FirmwareDumper,
    ForceTOCEdit,
    Tetris,
    getBestSuited,
    isCompatible,
    PCMFasterUpload,
    AtracRecoveryConfig,
    SPUpload,
    Assembler,
    HiMDUSBClassOverride,
    CachedSectorControlDownload,
    ConsoleLogger,
    MonoSPUpload,
} from 'netmd-exploits';
import netmdExploits from 'netmd-exploits';
import { HiMDCodecName } from 'himd-js';

const Worker = require('worker-loader!netmd-js/dist/web-encrypt-worker.js'); // eslint-disable-line import/no-webpack-loader-syntax

export enum Capability {
    contentList,
    playbackControl,
    metadataEdit,
    trackUpload,
    trackDownload,
    discEject,
    factoryMode,
    himdTitles,
    reinitializeFilesystem,
    fullWidthSupport,

    requiresManualFlush,
}

export enum ExploitCapability {
    runTetris,
    flushUTOC,
    downloadAtrac,
    readFirmware,
    spUploadSpeedup,
    uploadAtrac1,
    himdFullMode,
    readRam,
    uploadMonoSP,
}

export type CodecFamily = 'SP' | 'MONO' | 'LP2' | 'LP4' | HiMDCodecName;
export interface RecordingCodec {
    codec: CodecFamily;
    availableBitrates?: number[];
    defaultBitrate?: number;
}
export interface Codec {
    codec: CodecFamily;
    bitrate?: number;
}

export interface Track {
    index: number;
    title: string | null;
    fullWidthTitle: string | null;
    duration: number;
    channel: number;
    encoding: Codec;
    protected: TrackFlag;

    album?: string;
    artist?: string;
}

export interface Group {
    index: number;
    title: string | null;
    fullWidthTitle: string | null;
    tracks: Track[];
}

export interface Disc {
    title: string;
    fullWidthTitle: string;
    writable: boolean;
    writeProtected: boolean;
    used: number;
    left: number;
    total: number;
    trackCount: number;
    groups: Group[];
}

export interface MinidiscSpec {
    readonly availableFormats: RecordingCodec[];
    readonly defaultFormat: Codec;
    readonly specName: string;
    sanitizeHalfWidthTitle(title: string): string;
    sanitizeFullWidthTitle(title: string): string;
    getRemainingCharactersForTitles(disc: Disc): { halfWidth: number; fullWidth: number };
    getCharactersForTitle(track: Track): { halfWidth: number; fullWidth: number };
    translateDefaultMeasuringModeTo(mode: Codec, defaultMeasuringModeDuration: number): number;
    translateToDefaultMeasuringModeFrom(mode: Codec, defaultMeasuringModeDuration: number): number;
}

export const WireformatDict: { [k: string]: Wireformat } = {
    SP: Wireformat.pcm,
    LP2: Wireformat.lp2,
    LP105: Wireformat.l105kbps,
    LP4: Wireformat.lp4,
};

export type TitleParameter = string | { title?: string; album?: string; artist?: string };

export class DefaultMinidiscSpec implements MinidiscSpec {
    public readonly availableFormats: RecordingCodec[] = [{ codec: 'SP' }, { codec: 'MONO' }, { codec: 'LP2' }, { codec: 'LP4' }];
    public readonly defaultFormat = { codec: 'SP' } as const;
    public readonly specName = 'MD';

    sanitizeHalfWidthTitle(title: string): string {
        return sanitizeHalfWidthTitle(title);
    }
    sanitizeFullWidthTitle(title: string): string {
        return sanitizeFullWidthTitle(title);
    }

    private fixupCodec(codec: Codec) {
        if (codec.codec !== 'AT3') return codec;
        return { codec: codec.bitrate === 66 ? 'LP4' : 'LP2' };
    }

    getRemainingCharactersForTitles(disc: Disc) {
        return getRemainingCharactersForTitles(convertDiscToNJS(disc));
    }

    getCharactersForTitle(track: Track) {
        const { halfWidth, fullWidth } = getCellsForTitle(convertTrackToNJS(track));
        return {
            halfWidth: halfWidth * 7,
            fullWidth: fullWidth * 7,
        };
    }

    translateDefaultMeasuringModeTo(_mode: Codec, defaultMeasuringModeDuration: number): number {
        let mode = this.fixupCodec(_mode);
        return (
            {
                SP: 1,
                MONO: 2,
                LP2: 2,
                LP4: 4,
            }[mode.codec as 'SP' | 'LP2' | 'LP4']! * defaultMeasuringModeDuration
        );
    }
    translateToDefaultMeasuringModeFrom(_mode: Codec, durationInMode: number): number {
        let mode = this.fixupCodec(_mode);
        return (
            durationInMode /
            {
                SP: 1,
                MONO: 2,
                LP2: 2,
                LP4: 4,
            }[mode.codec as 'SP' | 'LP2' | 'LP4']!
        );
    }
}

export abstract class NetMDService {
    mutex: Mutex = new Mutex();

    abstract getServiceCapabilities(): Promise<Capability[]>;
    abstract getDeviceStatus(): Promise<DeviceStatus>;
    abstract pair(): Promise<boolean>;
    abstract connect(): Promise<boolean>;
    abstract listContent(dropCache?: boolean): Promise<Disc>;
    abstract getDeviceName(): Promise<string>;
    abstract finalize(): Promise<void>;
    abstract renameTrack(index: number, newTitle: TitleParameter, newFullWidthTitle?: string): Promise<void>;
    abstract renameDisc(newName: string, newFullWidthName?: string): Promise<void>;
    abstract renameGroup(groupIndex: number, newTitle: string, newFullWidthTitle?: string): Promise<void>;
    abstract addGroup(groupBegin: number, groupLength: number, name: string, fullWidthTitle?: string): Promise<void>;
    abstract deleteGroup(groupIndex: number): Promise<void>;
    abstract rewriteGroups(groups: Group[]): Promise<void>;
    abstract deleteTracks(indexes: number[]): Promise<void>;
    abstract moveTrack(src: number, dst: number, updateGroups?: boolean): Promise<void>;
    abstract wipeDisc(): Promise<void>;
    abstract ejectDisc(): Promise<void>;
    abstract wipeDiscTitleInfo(): Promise<void>;
    abstract prepareUpload(): Promise<void>;
    abstract finalizeUpload(): Promise<void>;
    abstract upload(
        title: TitleParameter,
        fullWidthTitle: string,
        data: ArrayBuffer,
        format: Codec,
        progressCallback: (progress: { written: number; encrypted: number; total: number }) => void
    ): Promise<void>;
    abstract download(
        index: number,
        progressCallback: (progress: { read: number; total: number }) => void
    ): Promise<{ format: DiscFormat; data: Uint8Array } | null>;
    abstract play(): Promise<void>;
    abstract pause(): Promise<void>;
    abstract stop(): Promise<void>;
    abstract next(): Promise<void>;
    abstract prev(): Promise<void>;
    abstract gotoTrack(index: number): Promise<void>;
    abstract gotoTime(index: number, hour: number, minute: number, second: number, frame: number): Promise<void>;
    abstract getPosition(): Promise<number[] | null>;

    async factory(): Promise<NetMDFactoryService | null> {
        return null;
    }

    async canBeFlushed(): Promise<boolean> {
        return false;
    }

    async flush(): Promise<void> {}
}

export interface NetMDFactoryService {
    mutex: Mutex;
    readUTOCSector(index: number): Promise<Uint8Array>;
    writeUTOCSector(index: number, data: Uint8Array): Promise<void>;
    getDeviceFirmware(): Promise<string>;
    getExploitCapabilities(): Promise<ExploitCapability[]>;
    readRAM(callback?: (progress: { readBytes: number; totalBytes: number }) => void): Promise<Uint8Array>;

    // depend on netmd-exploits:
    flushUTOCCacheToDisc(): Promise<void>;
    runTetris(): Promise<void>;
    readFirmware(
        callback: (progress: { type: 'RAM' | 'ROM' | 'DRAM'; readBytes: number; totalBytes: number }) => void
    ): Promise<{ rom: Uint8Array; ram: Uint8Array; dram?: Uint8Array }>;

    prepareDownload(useSlowerExploit: boolean): Promise<void>;
    exploitDownloadTrack(
        track: number,
        nerawDownload: boolean,
        callback: (data: { read: number; total: number; action: 'READ' | 'SEEK' | 'CHUNK'; sector?: string }) => void,
        config?: AtracRecoveryConfig
    ): Promise<Uint8Array>;
    finalizeDownload(): Promise<void>;

    setSPSpeedupActive(newState: boolean): Promise<void>;
    uploadSP(
        title: string,
        fullWidthTitle: string,
        mono: boolean,
        data: ArrayBuffer,
        progressCallback: (progress: { written: number; encrypted: number; total: number }) => void
    ): Promise<number>;

    enableHiMDFullMode(): Promise<void>;
    enableMonoUpload(enable: boolean): Promise<void>;
}

// Compatibility methods. Do NOT use these unless absolutely necessary!!
export function convertDiscToWMD(source: NetMDDisc): Disc {
    return {
        ...source,
        left: Math.ceil(source.left / 512),
        total: Math.ceil(source.total / 512),
        groups: source.groups.map(convertGroupToWMD),
    };
}

export function convertDiscToNJS(source: Disc): NetMDDisc {
    return {
        ...source,
        left: source.left * 512,
        total: source.total * 512,
        groups: source.groups.map(convertGroupToNJS),
    };
}

export function convertGroupToWMD(source: NetMDGroup): Group {
    return {
        ...source,
        tracks: source.tracks.map(convertTrackToWMD),
    };
}

export function convertGroupToNJS(source: Group): NetMDGroup {
    return {
        ...source,
        tracks: source.tracks.map(convertTrackToNJS),
    };
}

export function convertTrackToWMD(source: NetMDTrack) {
    return {
        ...source,
        duration: Math.ceil(source.duration / 512),
        encoding: {
            [Encoding.sp]: { codec: 'SP' },
            [Encoding.lp2]: { codec: 'LP2' },
            [Encoding.lp4]: { codec: 'LP4' },
        }[source.encoding]! as Codec,
    };
}

export function convertTrackToNJS(source: Track): NetMDTrack {
    return {
        ...source,
        duration: source.duration * 512,
        encoding: {
            SP: Encoding.sp,
            LP2: Encoding.lp2,
            LP4: Encoding.lp4,
        }[['SP', 'LP2', 'LP4'].includes(source.encoding.codec) ? (source.encoding.codec as 'SP' | 'LP2' | 'LP4') : 'SP'],
    };
}

export class NetMDUSBService extends NetMDService {
    private netmdInterface?: NetMDInterface;
    private logger?: Logger;
    private cachedContentList?: Disc;
    public statusMonitorTimer: any;
    public currentSession?: MDSession;

    constructor({ debug = false }: { debug: boolean }) {
        super();
        if (debug) {
            // Logging a few methods that have been causing issues with some units
            const _fn = (...args: any) => {
                if (args && args[0] && args[0].method) {
                    console.log(...args);
                }
            };
            this.logger = {
                debug: _fn,
                info: _fn,
                warn: _fn,
                error: _fn,
                child: () => this.logger!,
            };
        }

        Object.defineProperty(window, 'exposeAPIToConsole', {
            writable: true,
            configurable: true,
            value: () => {
                console.log('%cThe following features have been exposed:', 'font-size: 20px; color: cyan;');
                console.log('%c- formatQuery() - a function which formats given hex data with parameters', 'font-size: 15px; color: cyan;');
                console.log(
                    '%c- scanQuery() - a function which parses data with the help of a given hex format with parameters',
                    'font-size: 15px; color: cyan;'
                );
                console.log('%c- patch() - a function which patches the device', 'font-size: 15px; color: cyan;');
                console.log('%c- unpatch() - a function which removes a patch', 'font-size: 15px; color: cyan;');
                console.log("%c- interface - an instance of netmd-js's NetMDInterface", 'font-size: 15px; color: cyan;');
                Object.defineProperty(window, 'formatQuery', { value: formatQuery, configurable: true });
                Object.defineProperty(window, 'scanQuery', { value: scanQuery, configurable: true });
                Object.defineProperty(window, 'patch', { value: patch, configurable: true });
                Object.defineProperty(window, 'unpatch', { value: unpatch, configurable: true });
                Object.defineProperty(window, 'interface', { value: this.netmdInterface, configurable: true });
            },
        });

        console.log(
            '%cIf you would like to experiment with NetMD features in the console, please run exposeAPIToConsole()',
            'font-size: 25px; color: cyan;'
        );
    }

    @asyncMutex
    async getServiceCapabilities() {
        const basic = [Capability.contentList, Capability.playbackControl, Capability.fullWidthSupport];
        if (this.netmdInterface?.netMd.getVendor() === 0x54c && this.netmdInterface.netMd.getProduct() === 0x0286) {
            // MZ-RH1
            basic.push(Capability.trackDownload);
        }
        if (await this.netmdInterface?.canEjectDisc()) {
            basic.push(Capability.discEject);
        }

        // TODO: Add a flag for this instead of relying just on the name.
        const deviceName = this.netmdInterface?.netMd.getDeviceName();
        if (
            (deviceName?.includes('Sony') &&
                (deviceName?.includes('MZ-N') || deviceName?.includes('MZ-S1') || deviceName.includes('MZ-RH')) &&
                !deviceName.includes('DH10') /* && deviceName !== 'Sony MZ-RH1'*/) ||
            (deviceName?.includes('Aiwa') && deviceName?.includes('AM-NX')) ||
            deviceName?.includes('PCGA-MDN1')
        ) {
            // Only Sony (and Aiwa since it's the same thing) portables have the factory mode.
            basic.push(Capability.factoryMode);
        }

        try {
            const flags = (await this.netmdInterface?.getDiscFlags()) ?? 0;
            if ((flags & DiscFlag.writeProtected) === 0) {
                return [...basic, Capability.trackUpload, Capability.metadataEdit];
            }
        } catch (err) {}
        return basic;
    }

    private async listContentUsingCache() {
        if (!this.cachedContentList) {
            console.log("There's no cached version of the TOC, caching");
            this.cachedContentList = convertDiscToWMD(await listContent(this.netmdInterface!));
        } else {
            console.log("There's a cached TOC available.");
        }
        return JSON.parse(JSON.stringify(this.cachedContentList)) as Disc;
    }

    protected dropCachedContentList() {
        console.log('Cached TOC Dropped');
        this.cachedContentList = undefined;
    }

    async pair() {
        this.dropCachedContentList();
        let iface = await openNewDevice(navigator.usb, this.logger);
        if (iface === null) {
            return false;
        }
        this.netmdInterface = iface;
        return true;
    }

    async connect() {
        this.dropCachedContentList();
        let iface = await openPairedDevice(navigator.usb, this.logger);
        if (iface === null) {
            return false;
        }
        this.netmdInterface = iface;
        return true;
    }

    @asyncMutex
    async listContent(dropCache: boolean = false) {
        if (dropCache) this.dropCachedContentList();
        return await this.listContentUsingCache();
    }

    @asyncMutex
    async getDeviceStatus() {
        return await getDeviceStatus(this.netmdInterface!);
    }

    @asyncMutex
    async getDeviceName() {
        return this.netmdInterface!.netMd.getDeviceName();
    }

    @asyncMutex
    async finalize() {
        await this.netmdInterface!.netMd.finalize();
        this.dropCachedContentList();
    }

    @asyncMutex
    async rewriteGroups(groups: Group[]) {
        const disc = await this.listContentUsingCache();
        disc.groups = groups;
        this.cachedContentList = disc;
        await rewriteDiscGroups(this.netmdInterface!, convertDiscToNJS(disc));
    }

    @asyncMutex
    async renameTrack(index: number, title: string, fullWidthTitle?: string) {
        title = sanitizeHalfWidthTitle(title);
        await this.netmdInterface!.setTrackTitle(index, title);
        if (fullWidthTitle !== undefined) {
            await this.netmdInterface!.setTrackTitle(index, sanitizeFullWidthTitle(fullWidthTitle), true);
        }
        const disc = await this.listContentUsingCache();
        for (let group of disc.groups) {
            for (let track of group.tracks) {
                if (track.index === index) {
                    track.title = title;
                    if (fullWidthTitle !== undefined) {
                        track.fullWidthTitle = fullWidthTitle;
                    }
                }
            }
        }
        this.cachedContentList = disc;
    }

    @asyncMutex
    async renameGroup(groupIndex: number, newName: string, newFullWidthName?: string) {
        const disc = await this.listContentUsingCache();
        let thisGroup = disc.groups.find(g => g.index === groupIndex);
        if (!thisGroup) {
            return;
        }

        thisGroup.title = newName;
        if (newFullWidthName !== undefined) {
            thisGroup.fullWidthTitle = newFullWidthName;
        }
        this.cachedContentList = disc;
        await rewriteDiscGroups(this.netmdInterface!, convertDiscToNJS(disc));
    }

    @asyncMutex
    async addGroup(groupBegin: number, groupLength: number, title: string, fullWidthTitle: string = '') {
        const disc = await this.listContentUsingCache();
        let ungrouped = disc.groups.find(n => n.title === null);
        if (!ungrouped) {
            return; // You can only group tracks that aren't already in a different group, if there's no such tracks, there's no point to continue
        }

        let ungroupedLengthBeforeGroup = ungrouped.tracks.length;

        let thisGroupTracks = ungrouped.tracks.filter(n => n.index >= groupBegin && n.index < groupBegin + groupLength);
        ungrouped.tracks = ungrouped.tracks.filter(n => !thisGroupTracks.includes(n));

        if (ungroupedLengthBeforeGroup - ungrouped.tracks.length !== groupLength) {
            throw new Error('A track cannot be in 2 groups!');
        }

        if (!isSequential(thisGroupTracks.map(n => n.index))) {
            throw new Error('Invalid sequence of tracks!');
        }

        disc.groups.push({
            title,
            fullWidthTitle,
            index: disc.groups.length,
            tracks: thisGroupTracks,
        });
        disc.groups = disc.groups.filter(g => g.tracks.length !== 0).sort((a, b) => a.tracks[0].index - b.tracks[0].index);
        this.cachedContentList = disc;
        await rewriteDiscGroups(this.netmdInterface!, convertDiscToNJS(disc));
    }

    @asyncMutex
    async deleteGroup(index: number) {
        const disc = await this.listContentUsingCache();

        let ungroupedGroup = disc.groups.find(g => g.title === null);
        if (!ungroupedGroup) {
            ungroupedGroup = {
                index: -1,
                title: null,
                fullWidthTitle: null,
                tracks: [],
            };
            disc.groups.unshift(ungroupedGroup);
        }
        let groupIndex = disc.groups.findIndex(g => g.index === index);
        if (groupIndex >= 0) {
            const deleted = disc.groups.splice(groupIndex, 1)[0];
            ungroupedGroup.tracks = ungroupedGroup.tracks.concat(deleted.tracks);
            ungroupedGroup.tracks.sort((a, b) => a.index - b.index);
        }

        this.cachedContentList = disc;
        await rewriteDiscGroups(this.netmdInterface!, convertDiscToNJS(disc));
    }

    @asyncMutex
    async renameDisc(newName: string, newFullWidthName?: string) {
        await renameDisc(this.netmdInterface!, newName, newFullWidthName);
        const disc = await this.listContentUsingCache();
        disc.title = newName;
        if (newFullWidthName !== undefined) {
            disc.fullWidthTitle = newFullWidthName;
        }
        this.cachedContentList = disc;
    }

    @asyncMutex
    async deleteTracks(indexes: number[]) {
        try {
            // await this.netmdInterface!.stop();
        } catch (ex) {}
        indexes = indexes.sort();
        indexes.reverse();
        let content = await this.listContentUsingCache();
        for (let index of indexes) {
            // Attempt to get panasonics working correctly (MyNameIsX)
            await this.netmdInterface?.getTrackTitle(index, false);
            await this.netmdInterface?.getTrackCount();
            content = recomputeGroupsAfterTrackMove(content, index, -1);
            await this.netmdInterface!.eraseTrack(index);
            await sleep(100);
        }
        await rewriteDiscGroups(this.netmdInterface!, convertDiscToNJS(content));
        this.dropCachedContentList();
    }

    @asyncMutex
    async wipeDisc() {
        try {
            await this.netmdInterface!.stop();
        } catch (ex) {}
        await this.netmdInterface!.eraseDisc();
        this.dropCachedContentList();
    }

    @asyncMutex
    async ejectDisc() {
        await this.netmdInterface!.ejectDisc();
        this.dropCachedContentList();
    }

    @asyncMutex
    async wipeDiscTitleInfo() {
        await this.netmdInterface!.setDiscTitle('');
        await this.netmdInterface!.setDiscTitle('', true);
        this.dropCachedContentList();
    }

    @asyncMutex
    async moveTrack(src: number, dst: number, updateGroups?: boolean) {
        await this.netmdInterface!.moveTrack(src, dst);

        const content = await this.listContentUsingCache();
        if (updateGroups === undefined || updateGroups) {
            await rewriteDiscGroups(this.netmdInterface!, convertDiscToNJS(recomputeGroupsAfterTrackMove(content, src, dst)));
        }
        for (let group of content.groups) {
            for (let track of group.tracks) {
                if (track.index === dst) {
                    track.index = src;
                } else if (track.index === src) {
                    track.index = dst;
                }
            }
            group.tracks.sort((a, b) => a.index - b.index);
        }
        this.cachedContentList = content;
    }

    @asyncMutex
    async prepareUpload() {
        await prepareDownload(this.netmdInterface!);
        this.currentSession = new MDSession(this.netmdInterface!, new EKBOpenSource());
        await this.currentSession.init();
    }

    @asyncMutex
    async finalizeUpload() {
        await this.currentSession!.close();
        await this.netmdInterface!.release();
        this.currentSession = undefined;
        this.dropCachedContentList();
    }

    @asyncMutex
    async upload(
        title: string,
        fullWidthTitle: string,
        data: ArrayBuffer,
        _format: Codec,
        progressCallback: (progress: { written: number; encrypted: number; total: number }) => void
    ) {
        let format = _format.codec === 'AT3' ? { codec: _format.bitrate === 66 ? 'LP4' : 'LP2' } :
                     _format.codec === 'MONO' ? { codec: 'SP' } : _format;
        if (this.currentSession === undefined) {
            throw new Error('Cannot upload without initializing a session first');
        }
        let total = data.byteLength;
        let written = 0;
        let encrypted = 0;
        function updateProgress() {
            progressCallback({ written, encrypted, total });
        }

        let w = new Worker();

        let webWorkerAsyncPacketIterator = makeGetAsyncPacketIteratorOnWorkerThread(w, ({ encryptedBytes }) => {
            encrypted = encryptedBytes;
            updateProgress();
        });

        let halfWidthTitle = sanitizeHalfWidthTitle(title);
        fullWidthTitle = sanitizeFullWidthTitle(fullWidthTitle);
        let mdTrack = new MDTrack(halfWidthTitle, WireformatDict[format.codec], data, 0x400, fullWidthTitle, webWorkerAsyncPacketIterator);

        await this.currentSession.downloadTrack(mdTrack, ({ writtenBytes }) => {
            written = writtenBytes;
            updateProgress();
        }, _format.codec === 'MONO' ? DiscFormat.spMono : undefined);

        w.terminate();
        this.dropCachedContentList();
    }

    @asyncMutex
    async download(index: number, progressCallback: (progress: { read: number; total: number }) => void) {
        const [format, data] = await upload(this.netmdInterface!, index, ({ readBytes, totalBytes }) => {
            progressCallback({ read: readBytes, total: totalBytes });
        });
        return { format, data };
    }

    @asyncMutex
    async play() {
        await this.netmdInterface!.play();
    }
    @asyncMutex
    async pause() {
        await this.netmdInterface!.pause();
    }
    @asyncMutex
    async stop() {
        await this.netmdInterface!.stop();
    }
    @asyncMutex
    async next() {
        await this.netmdInterface!.nextTrack();
    }
    @asyncMutex
    async prev() {
        await this.netmdInterface!.previousTrack();
    }

    @asyncMutex
    async gotoTrack(index: number) {
        await this.netmdInterface!.gotoTrack(index);
    }

    @asyncMutex
    async gotoTime(index: number, h: number, m: number, s: number, f: number) {
        await this.netmdInterface!.gotoTime(index, h, m, s, f);
    }

    @asyncMutex
    async getPosition() {
        return await this.netmdInterface!.getPosition();
    }

    @asyncMutex
    async factory() {
        Assembler.setWASMUrl(getPublicPathFor('assembler.wasm'));
        try {
            await this.netmdInterface!.stop();
        } catch (_) {
            /* Ignore */
        }
        const factoryInstance = await this.netmdInterface!.factory();
        const esm = await ExploitStateManager.create(this.netmdInterface!, factoryInstance, ConsoleLogger);
        return new NetMDFactoryUSBService(factoryInstance, this, this.mutex, esm);
    }
}

class NetMDFactoryUSBService implements NetMDFactoryService {
    private atracDownloader?: AtracRecovery;
    private fasterTransferEnabled = false;
    constructor(
        private factoryInterface: NetMDFactoryInterface,
        private parent: NetMDUSBService,
        public mutex: Mutex,
        public exploitStateManager: ExploitStateManager
    ) {}
    async getExploitCapabilities() {
        let capabilities: ExploitCapability[] = [];
        const bind = (a: any, b: ExploitCapability) => isCompatible(a, this.exploitStateManager.device) && capabilities.push(b);

        bind(FirmwareDumper, ExploitCapability.readFirmware);
        bind(AtracRecovery, ExploitCapability.downloadAtrac);
        bind(Tetris, ExploitCapability.runTetris);
        bind(ForceTOCEdit, ExploitCapability.flushUTOC);
        bind(PCMFasterUpload, ExploitCapability.spUploadSpeedup);
        bind(SPUpload, ExploitCapability.uploadAtrac1);
        bind(HiMDUSBClassOverride, ExploitCapability.himdFullMode);
        bind(MonoSPUpload, ExploitCapability.uploadMonoSP);
        if (!this.exploitStateManager.device.isHimd) {
            // Non-HiMD devices can read the RAM using normal commands
            capabilities.push(ExploitCapability.readRam);
        }

        if ((window as any).interface) {
            Object.defineProperty(window, 'exploitStateManager', { value: this.exploitStateManager, configurable: true });
            Object.defineProperty(window, 'exploits', { value: netmdExploits, configurable: true });
        }

        return capabilities;
    }

    @asyncMutex
    async readUTOCSector(index: number) {
        return await readUTOCSector(this.factoryInterface, index);
    }

    @asyncMutex
    async writeUTOCSector(index: number, data: Uint8Array) {
        await writeUTOCSector(this.factoryInterface, index, data);
    }

    @asyncMutex
    async flushUTOCCacheToDisc() {
        await (await this.exploitStateManager.require(ForceTOCEdit)).forceTOCEdit();
    }

    @asyncMutex
    async runTetris() {
        await (await this.exploitStateManager.require(Tetris)).playTetris();
    }

    @asyncMutex
    async getDeviceFirmware() {
        return getDescriptiveDeviceCode(this.factoryInterface);
    }

    @asyncMutex
    async readRAM(callback: (progress?: { readBytes: number; totalBytes: number }) => void): Promise<Uint8Array> {
        const firmwareVersion = await getDescriptiveDeviceCode(this.factoryInterface);
        const ramSize = firmwareVersion.startsWith('R') ? 0x4800 : 0x9000;
        let readSlices: Uint8Array[] = [];
        for (let i = 0; i < ramSize; i += 0x10) {
            readSlices.push(await cleanRead(this.factoryInterface, i + 0x02000000, 0x10, MemoryType.MAPPED));
            if (callback !== undefined) callback({ readBytes: i, totalBytes: ramSize });
        }

        return concatUint8Arrays(...readSlices);
    }

    @asyncMutex
    async readFirmware(callback: (progress: { type: 'RAM' | 'ROM' | 'DRAM'; readBytes: number; totalBytes: number }) => void) {
        const firmwareRipper = await this.exploitStateManager.require(FirmwareDumper);
        return await firmwareRipper.readFirmware(callback);
    }

    @asyncMutex
    async prepareDownload(useSlowerExploit: boolean): Promise<void> {
        if (useSlowerExploit && !isCompatible(CachedSectorControlDownload, this.exploitStateManager.device)) {
            alert('Slower exploit is not compatible with this device. Falling back to default');
            useSlowerExploit = false;
        }
        const exploitConstructor = useSlowerExploit
            ? CachedSectorControlDownload
            : getBestSuited(AtracRecovery, this.exploitStateManager.device)!;
        this.atracDownloader = await this.exploitStateManager.require(exploitConstructor);
    }

    @asyncMutex
    async finalizeDownload(): Promise<void> {
        if (this.atracDownloader) await this.exploitStateManager.unload(this.atracDownloader);
    }

    @asyncMutex
    async exploitDownloadTrack(
        track: number,
        nerawDownload: boolean,
        callback: (data: { read: number; total: number; action: 'READ' | 'SEEK' | 'CHUNK'; sector?: string }) => void,
        config?: AtracRecoveryConfig
    ) {
        if (nerawDownload) {
            return this.atracDownloader!.downloadTrackWithMarkers(track, callback, {
                ...config,
                includeMetadataSection: true,
                removeLPBytes: 'never',
            });
        } else {
            return this.atracDownloader!.downloadTrack(track, callback, config);
        }
    }

    @asyncMutex
    async setSPSpeedupActive(newState: boolean) {
        if (this.fasterTransferEnabled === newState) return;
        this.fasterTransferEnabled = newState;
        if (newState) {
            await this.exploitStateManager.require(PCMFasterUpload);
        } else {
            await this.exploitStateManager.unload(PCMFasterUpload);
        }
    }

    @asyncMutex
    async uploadSP(
        title: string,
        fullWidthTitle: string,
        mono: boolean,
        data: ArrayBuffer,
        progressCallback: (progress: { written: number; encrypted: number; total: number }) => void
    ) {
        // The patch memory is too small to accomodate for both ATRAC1Upload and PCMFasterUpload.
        if (this.fasterTransferEnabled) {
            await this.exploitStateManager.unload(PCMFasterUpload);
        }

        if (this.parent.currentSession === undefined) {
            throw new Error('Cannot upload without initializing a session first');
        }
        let total = data.byteLength;
        let written = 0;
        let encrypted = 0;
        function updateProgress() {
            progressCallback({ written, encrypted, total });
        }

        let w = new Worker();

        let webWorkerAsyncPacketIterator = makeGetAsyncPacketIteratorOnWorkerThread(w, ({ encryptedBytes }) => {
            encrypted = encryptedBytes;
            updateProgress();
        });

        let halfWidthTitle = sanitizeHalfWidthTitle(title);
        fullWidthTitle = sanitizeFullWidthTitle(fullWidthTitle);
        let mdTrack = new MDTrack(halfWidthTitle, Wireformat.l105kbps, data, 0x400, fullWidthTitle, webWorkerAsyncPacketIterator);

        let index = -1;

        await this.exploitStateManager.envelop(SPUpload, mono ? 1 : 2, async spUpload => {
            mdTrack = spUpload.prepareTrack(mdTrack);
            total = mdTrack.data.byteLength;
            [index] = (await this.parent.currentSession!.downloadTrack(mdTrack, ({ writtenBytes }) => {
                written = writtenBytes;
                updateProgress();
            })) as any;
        });

        w.terminate();

        if (this.fasterTransferEnabled) {
            await this.exploitStateManager.require(PCMFasterUpload);
        }
        return index as number;
    }

    @asyncMutex
    async enableHiMDFullMode() {
        await this.exploitStateManager.require(HiMDUSBClassOverride);
    }

    @asyncMutex
    async enableMonoUpload(enable: boolean){
        if(enable){
            await this.exploitStateManager.require(MonoSPUpload);
        }else{
            await this.exploitStateManager.unload(MonoSPUpload);
        }
    }
}
