import {
  Button as HeroButton,
  DropdownPopover as HeroDropdownPopover,
  DropdownSubmenuTrigger as HeroDropdownSubmenuTrigger,
  Input as HeroInput,
  ListBox as HeroListBox,
  ListBoxItem as HeroListBoxItem,
  Menu as HeroMenu,
  MenuItem as HeroMenuItem,
  MenuSection as HeroMenuSection,
  ModalBackdrop as HeroModalBackdrop,
  ModalContainer as HeroModalContainer,
  ModalDialog as HeroModalDialog,
  PopoverContent as HeroPopoverContent,
  PopoverDialog as HeroPopoverDialog,
  Select as HeroSelect,
  SelectIndicator as HeroSelectIndicator,
  SelectPopover as HeroSelectPopover,
  SelectTrigger as HeroSelectTrigger,
  SelectValue as HeroSelectValue,
  Spinner as HeroSpinner,
  Surface as HeroSurface,
  TextArea as HeroTextArea,
} from "@heroui/react";
import {
  Children,
  Fragment,
  forwardRef,
  isValidElement,
  cloneElement,
  type ButtonHTMLAttributes,
  type ChangeEvent,
  type ComponentProps,
  type HTMLAttributes,
  type InputHTMLAttributes,
  type ReactElement,
  type ReactNode,
  type RefObject,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from "react";
import { useHeroUIAlpha } from "../../context/HeroUIAlphaContext";

type AlphaButtonProps = ButtonHTMLAttributes<HTMLButtonElement>;
type AlphaInputProps = InputHTMLAttributes<HTMLInputElement>;
type AlphaTextAreaProps = TextareaHTMLAttributes<HTMLTextAreaElement>;
type AlphaSurfaceProps = HTMLAttributes<HTMLDivElement>;
type AlphaSelectProps = SelectHTMLAttributes<HTMLSelectElement> & { "data-testid"?: string };
type AlphaMenuProps = HTMLAttributes<HTMLDivElement> & { "aria-label": string };
type AlphaMenuSectionProps = HTMLAttributes<HTMLElement> & { "aria-label": string };
export type AlphaMenuItemProps = ButtonHTMLAttributes<HTMLButtonElement> & { id?: string };
type AlphaMenuRowProps = AlphaMenuItemProps & {
  collectionLabel: string;
  auxiliary?: ReactNode;
  rowClassName?: string;
};
type AlphaMenuSubmenuProps = {
  id: string;
  label: string;
  className?: string;
  menuClassName?: string;
  children: ReactNode;
};
type AlphaListBoxProps = HTMLAttributes<HTMLElement> & {
  "aria-label": string;
  legacyAs?: "div" | "ul";
};
type AlphaListBoxRowProps = AlphaListBoxItemProps & {
  collectionLabel: string;
  auxiliary?: ReactNode;
  rowClassName?: string;
};
export type AlphaListBoxItemProps = HTMLAttributes<HTMLElement> & {
  id: string;
  textValue: string;
  isDisabled?: boolean;
  legacyAs?: "button" | "div" | "li";
};

/*
FNXC:HeroUIAlphaPrimitives 2026-09-10-18:19:
Adaptive primitives preserve each existing Board/Chat business callback and accessible name. Inside the Alpha surface they delegate interaction semantics directly to HeroUI v3, including selects, menus, and dialogs; outside it they return the historical native element and classes.

FNXC:HeroUIAlphaPrimitives 2026-09-10-18:49:
Alpha listboxes and floating dialog panels must also be HeroUI-owned rather than custom role shells. Their legacy element shape remains selectable so disabling Alpha preserves the existing Board and Chat DOM contract.

FNXC:HeroUIAlphaCollections 2026-09-10-20:43:
React Aria collection roots receive one complete set of HeroUI items or native sections so arrow navigation crosses every related command. Auxiliary controls remain labelled sibling chrome after the collection, while nested task actions use HeroUI's native SubmenuTrigger contract rather than isolated one-item menus.
*/

function splitDirectCollectionChildren(children: ReactNode, ItemType: unknown): { items: ReactNode[]; chrome: ReactNode[] } {
  const items: ReactNode[] = [];
  const chrome: ReactNode[] = [];
  Children.forEach(children, (child) => {
    if (isValidElement<{ children?: ReactNode }>(child) && child.type === Fragment) {
      const nested = splitDirectCollectionChildren(child.props.children, ItemType);
      items.push(...nested.items);
      chrome.push(...nested.chrome);
    } else if (isValidElement(child) && (child.type === ItemType || child.type === AlphaMenuSubmenu || child.type === AlphaMenuSection)) {
      items.push(child);
    } else if (child !== null && child !== undefined && child !== false) {
      chrome.push(child);
    }
  });
  return { items, chrome };
}

export const AlphaButton = forwardRef<HTMLButtonElement, AlphaButtonProps>(function AlphaButton(
  { disabled, ...props },
  ref,
) {
  const alpha = useHeroUIAlpha();
  if (!alpha) return <button ref={ref} disabled={disabled} {...props} />;
  const heroProps = props as unknown as ComponentProps<typeof HeroButton>;
  return <HeroButton ref={ref} isDisabled={disabled} data-heroui-alpha="button" {...heroProps} />;
});

export const AlphaInput = forwardRef<HTMLInputElement, AlphaInputProps>(function AlphaInput(props, ref) {
  const alpha = useHeroUIAlpha();
  if (!alpha) return <input ref={ref} {...props} />;
  return <HeroInput ref={ref} data-heroui-alpha="input" {...props} />;
});

export const AlphaTextArea = forwardRef<HTMLTextAreaElement, AlphaTextAreaProps>(function AlphaTextArea(props, ref) {
  const alpha = useHeroUIAlpha();
  if (!alpha) return <textarea ref={ref} {...props} />;
  return <HeroTextArea ref={ref} data-heroui-alpha="textarea" {...props} />;
});

export const AlphaPopoverSurface = forwardRef<HTMLDivElement, AlphaSurfaceProps & { triggerRef?: RefObject<Element | null>; onClose?: () => void }>(function AlphaPopoverSurface({ children, triggerRef, onClose, ...props }, ref) {
  const alpha = useHeroUIAlpha();
  if (!alpha) return <div ref={ref} role="dialog" {...props}>{children}</div>;
  const contentProps = props as unknown as ComponentProps<typeof HeroPopoverContent>;
  return (
    <HeroPopoverContent isOpen triggerRef={triggerRef} onOpenChange={(open) => { if (!open) onClose?.(); }} data-heroui-alpha-portal="true" {...contentProps}>
      <HeroPopoverDialog ref={ref} data-heroui-alpha="popover">{children}</HeroPopoverDialog>
    </HeroPopoverContent>
  );
});

export const AlphaPortalSurface = forwardRef<HTMLDivElement, AlphaSurfaceProps>(function AlphaPortalSurface(props, ref) {
  const alpha = useHeroUIAlpha();
  if (!alpha) return <div ref={ref} {...props} />;
  const heroProps = props as unknown as ComponentProps<typeof HeroSurface>;
  return <HeroSurface ref={ref} data-heroui-alpha="portal-surface" data-heroui-alpha-portal="true" {...heroProps} />;
});

export const AlphaListBox = forwardRef<HTMLDivElement, AlphaListBoxProps>(function AlphaListBox(
  { children, legacyAs = "div", ...props },
  ref,
) {
  const alpha = useHeroUIAlpha();
  if (!alpha) {
    const LegacyElement = legacyAs;
    return <LegacyElement ref={ref as never} role="listbox" {...props}>{children}</LegacyElement>;
  }
  const heroProps = props as unknown as ComponentProps<typeof HeroListBox>;
  const { items, chrome } = splitDirectCollectionChildren(children, AlphaListBoxItem);
  if (chrome.length === 0) return <HeroListBox ref={ref as never} data-heroui-alpha="listbox" {...heroProps}>{items}</HeroListBox>;
  const { "aria-label": ariaLabel, ...chromeProps } = props;
  return <div ref={ref} {...chromeProps}><HeroListBox aria-label={ariaLabel} data-heroui-alpha="listbox">{items}</HeroListBox><div data-heroui-alpha-collection-chrome="listbox">{chrome}</div></div>;
});

export const AlphaListBoxItem = forwardRef<HTMLDivElement, AlphaListBoxItemProps>(function AlphaListBoxItem(
  { children, id, textValue, isDisabled, legacyAs = "div", onClick, ...props },
  ref,
) {
  const alpha = useHeroUIAlpha();
  if (!alpha) {
    const LegacyElement = legacyAs;
    return (
      <LegacyElement
        ref={ref as never}
        role="option"
        aria-disabled={isDisabled || undefined}
        {...(legacyAs === "button" ? { type: "button", disabled: isDisabled } : {})}
        onClick={onClick}
        {...props}
      >
        {children}
      </LegacyElement>
    );
  }
  const heroProps = props as unknown as ComponentProps<typeof HeroListBoxItem>;
  return (
    <HeroListBoxItem
      ref={ref as never}
      id={id}
      textValue={textValue}
      isDisabled={isDisabled}
      data-heroui-alpha="listbox-item"
      onAction={() => onClick?.({} as never)}
      {...heroProps}
    >
      {children}
    </HeroListBoxItem>
  );
});

export const AlphaListBoxRow = forwardRef<HTMLDivElement, AlphaListBoxRowProps>(function AlphaListBoxRow(
  { collectionLabel, auxiliary, rowClassName, children, className, legacyAs: _legacyAs, onClick, ...itemProps },
  ref,
) {
  const alpha = useHeroUIAlpha();
  if (!alpha) {
    return (
      <div ref={ref} className={rowClassName}>
        <AlphaListBoxItem className={className} onClick={onClick} {...itemProps}>{children}</AlphaListBoxItem>
        {auxiliary}
      </div>
    );
  }
  void collectionLabel;
  void auxiliary;
  void rowClassName;
  return (
    <HeroListBoxItem
      ref={ref as never}
      id={itemProps.id}
      textValue={itemProps.textValue}
      isDisabled={itemProps.isDisabled}
      className={className}
      data-heroui-alpha="listbox-item"
      onAction={() => onClick?.({} as never)}
      {...itemProps as ComponentProps<typeof HeroListBoxItem>}
    >
      {children}
    </HeroListBoxItem>
  );
});

export const AlphaDialogPanel = forwardRef<HTMLDivElement, AlphaSurfaceProps & { labelledBy?: string }>(function AlphaDialogPanel(
  { children, labelledBy, ...props },
  ref,
) {
  const alpha = useHeroUIAlpha();
  if (!alpha) return <div ref={ref} role="dialog" aria-modal="true" aria-labelledby={labelledBy} {...props}>{children}</div>;
  const heroProps = props as unknown as ComponentProps<typeof HeroModalDialog>;
  return (
    <div ref={ref} data-heroui-alpha="dialog-layout-host">
      <HeroModalDialog aria-labelledby={labelledBy} data-heroui-alpha="dialog" {...heroProps}>
        {children as ComponentProps<typeof HeroModalDialog>["children"]}
      </HeroModalDialog>
    </div>
  );
});

export const AlphaSurface = forwardRef<HTMLDivElement, AlphaSurfaceProps>(function AlphaSurface(props, ref) {
  const alpha = useHeroUIAlpha();
  if (!alpha) return <div ref={ref} {...props} />;
  const heroProps = props as unknown as ComponentProps<typeof HeroSurface>;
  return <HeroSurface ref={ref} data-heroui-alpha="surface" {...heroProps} />;
});

export const AlphaSelect = forwardRef<HTMLSelectElement, AlphaSelectProps>(function AlphaSelect(
  { children, disabled, onChange, value, defaultValue, className, "data-testid": testId, ...props },
  ref,
) {
  const alpha = useHeroUIAlpha();
  if (!alpha) return <select ref={ref} disabled={disabled} onChange={onChange} value={value} defaultValue={defaultValue} className={className} data-testid={testId} {...props}>{children}</select>;

  const options = Children.toArray(children).flatMap((child) => {
    if (!isValidElement<{ value?: string; disabled?: boolean; children?: ReactNode }>(child)) return [];
    return [{ key: String(child.props.value ?? ""), label: child.props.children, disabled: child.props.disabled === true }];
  });
  const selectedKey = String(value ?? defaultValue ?? "");
  return (
    <HeroSelect
      aria-label={props["aria-label"]}
      className={className}
      isDisabled={disabled}
      selectedKey={selectedKey}
      onSelectionChange={(key) => {
        const nextValue = String(key ?? "");
        onChange?.({ target: { value: nextValue } } as ChangeEvent<HTMLSelectElement>);
      }}
      data-heroui-alpha="select"
    >
      <HeroSelectTrigger data-testid={testId}>
        <HeroSelectValue />
        <HeroSelectIndicator />
      </HeroSelectTrigger>
      <HeroSelectPopover data-heroui-alpha-portal="true">
        <HeroListBox aria-label={props["aria-label"]}>
          {options.map((option) => (
            <HeroListBoxItem key={option.key} id={option.key} textValue={typeof option.label === "string" ? option.label : option.key} isDisabled={option.disabled}>
              {option.label}
            </HeroListBoxItem>
          ))}
        </HeroListBox>
      </HeroSelectPopover>
    </HeroSelect>
  );
});

export function AlphaMenuSubmenu({ id, label, className, menuClassName, children }: AlphaMenuSubmenuProps) {
  return (
    <HeroDropdownSubmenuTrigger>
      <HeroMenuItem id={`${id}-submenu`} className={className} data-task-submenu-toggle={id} data-heroui-alpha="menu-item">
        {label}
      </HeroMenuItem>
      <HeroDropdownPopover className={menuClassName} data-task-submenu={id} data-heroui-alpha-portal="true">
        <HeroMenu aria-label={label} data-heroui-alpha="menu">{children}</HeroMenu>
      </HeroDropdownPopover>
    </HeroDropdownSubmenuTrigger>
  );
}

export function AlphaMenuSection({ children, ...props }: AlphaMenuSectionProps) {
  const alpha = useHeroUIAlpha();
  if (!alpha) return <div role="group" {...props}>{children}</div>;
  return <HeroMenuSection {...props as ComponentProps<typeof HeroMenuSection>}>{children}</HeroMenuSection>;
}

export const AlphaMenu = forwardRef<HTMLDivElement, AlphaMenuProps>(function AlphaMenu({ children, ...props }, ref) {
  const alpha = useHeroUIAlpha();
  if (!alpha) return <div ref={ref} role="menu" {...props}>{children}</div>;
  const heroProps = props as unknown as ComponentProps<typeof HeroMenu>;
  const { items, chrome } = splitDirectCollectionChildren(children, AlphaMenuItem);
  if (chrome.length === 0) return <HeroMenu ref={ref} data-heroui-alpha="menu" {...heroProps}>{items}</HeroMenu>;
  const { "aria-label": ariaLabel, ...chromeProps } = props;
  return <div ref={ref} {...chromeProps}><HeroMenu aria-label={ariaLabel} data-heroui-alpha="menu">{items}</HeroMenu><div data-heroui-alpha-collection-chrome="menu">{chrome}</div></div>;
});

export const AlphaMenuRow = forwardRef<HTMLDivElement, AlphaMenuRowProps>(function AlphaMenuRow(
  { collectionLabel, auxiliary, rowClassName, children, className, disabled, id, onClick, ...itemProps },
  ref,
) {
  const alpha = useHeroUIAlpha();
  if (!alpha) {
    return (
      <div ref={ref} className={rowClassName}>
        <AlphaMenuItem className={className} disabled={disabled} id={id} onClick={onClick} {...itemProps}>{children}</AlphaMenuItem>
        {auxiliary}
      </div>
    );
  }
  void collectionLabel;
  void auxiliary;
  void rowClassName;
  return <HeroMenuItem ref={ref as never} id={id} isDisabled={disabled} onClick={onClick as ComponentProps<typeof HeroMenuItem>["onClick"]} className={className} data-heroui-alpha="menu-item" {...itemProps as ComponentProps<typeof HeroMenuItem>}>{children}</HeroMenuItem>;
});

export const AlphaMenuItem = forwardRef<HTMLButtonElement, AlphaMenuItemProps>(function AlphaMenuItem(
  { children, disabled, id, onClick, ...props },
  ref,
) {
  const alpha = useHeroUIAlpha();
  if (!alpha) return <button ref={ref} type="button" role="menuitem" disabled={disabled} onClick={onClick} {...props}>{children}</button>;
  const heroProps = props as unknown as ComponentProps<typeof HeroMenuItem>;
  return <HeroMenuItem ref={ref as unknown as ComponentProps<typeof HeroMenuItem>["ref"]} id={id} isDisabled={disabled} onClick={onClick as ComponentProps<typeof HeroMenuItem>["onClick"]} data-heroui-alpha="menu-item" {...heroProps}>{children}</HeroMenuItem>;
});

export function AlphaDialogBackdrop({ children, overlayClassName, onClose }: { children: ReactElement<HTMLAttributes<HTMLElement>>; overlayClassName?: string; onClose?: () => void }) {
  const alpha = useHeroUIAlpha();
  if (!alpha) return <div className={overlayClassName} role="presentation">{cloneElement(children, { role: "dialog", "aria-modal": true })}</div>;
  return (
    <HeroModalBackdrop isOpen isDismissable={Boolean(onClose)} onOpenChange={(open) => { if (!open) onClose?.(); }} className={overlayClassName} data-heroui-alpha="dialog-backdrop" data-heroui-alpha-portal="true">
      <HeroModalContainer>
        <HeroModalDialog data-heroui-alpha="dialog">{cloneElement(children, { role: "presentation", "aria-modal": undefined })}</HeroModalDialog>
      </HeroModalContainer>
    </HeroModalBackdrop>
  );
}

export function AlphaDialog({
  children,
  className,
  overlayClassName,
  labelledBy,
  onClose,
}: {
  children: ReactNode;
  className?: string;
  overlayClassName?: string;
  labelledBy?: string;
  onClose?: () => void;
}) {
  const alpha = useHeroUIAlpha();
  if (!alpha) {
    return <div className={overlayClassName} role="presentation"><div className={className} role="dialog" aria-modal="true" aria-labelledby={labelledBy}>{children}</div></div>;
  }
  return (
    <HeroModalBackdrop
      isOpen
      isDismissable={Boolean(onClose)}
      onOpenChange={(open) => { if (!open) onClose?.(); }}
      className={overlayClassName}
      data-heroui-alpha="dialog-backdrop"
      data-heroui-alpha-portal="true"
    >
      <HeroModalContainer className={className}>
        <HeroModalDialog aria-labelledby={labelledBy} data-heroui-alpha="dialog">{children}</HeroModalDialog>
      </HeroModalContainer>
    </HeroModalBackdrop>
  );
}

export function AlphaSpinner({ className, label }: { className?: string; label: string }) {
  const alpha = useHeroUIAlpha();
  if (!alpha) return <span className={className} role="status" aria-label={label} />;
  return <HeroSpinner className={className} aria-label={label} data-heroui-alpha="spinner" />;
}
